"""Compound source versions and current authority at actual transaction waits."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from uuid import UUID

import pytest
from sqlalchemy import event, select
from sqlalchemy.exc import OperationalError

from app.core.database.session import AuditSession
from app.systems.access.users.models import Membership
from app.systems.comms.messages.models import CommsConversationCounter, CommsMessage
from tests.comms.routes.message_support import _ok, send

pytestmark = pytest.mark.integration


def reported(case):
    org = case.world.first
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    message = send(peer, f"/api/comms/conversations/{org.conversation}/messages", "Retained source")
    path = f"/api/comms/conversations/{org.conversation}/messages/{message['id']}"
    assert peer.post(path + "/reports", json={"reason": "Review"}).status_code == 204
    report = _ok(admin.get("/api/comms/reports"))["items"][0]
    return admin, path, "/api/comms/reports/" + report["id"], message


def test_report_actions_reject_bodies_and_racing_old_validators(message_routes):
    case, org = message_routes, message_routes.world.first
    admin, path, report, _ = reported(case)
    tag = admin.get(report).headers["etag"]
    assert admin.post(report + "/message-removal", json={"message_id": str(org.other_conversation)},
                      headers={"If-Match": tag}).status_code == 422
    gate = Barrier(2)
    clients = [case.client(org.author, org.id, request_gate=gate) for _ in range(2)]
    events = []
    for client in clients:
        client.app.state.comms_publisher.submit = lambda rows: events.extend(rows)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(client.post, report + "/message-removal",
                               headers={"If-Match": tag}) for client in clients]
        responses = [future.result(timeout=30) for future in futures]
    assert sorted(response.status_code for response in responses) == [200, 412]
    assert [row["payload"]["kind"] for row in events if row["event"] == "message"] == ["deleted"]
    assert _ok(admin.get(path))["state"] == "deleted"


def test_failed_report_action_rolls_back_source_generation_and_publication(message_routes):
    case, org = message_routes, message_routes.world.first
    admin, path, report, message = reported(case)
    tag = admin.get(report).headers["etag"]
    events, reached = [], []
    admin.app.state.comms_publisher.submit = lambda rows: events.extend(rows)

    def fail_after_flush(db, _context):
        if db.get_bind() is case.world.runtime and any(
            isinstance(row, CommsMessage) and row.is_deleted for row in db.dirty
        ):
            reached.append(True)
            raise OperationalError("controlled moderation refusal", {}, RuntimeError())

    event.listen(AuditSession, "after_flush", fail_after_flush)
    try:
        response = admin.post(report + "/message-removal", headers={"If-Match": tag})
    finally:
        event.remove(AuditSession, "after_flush", fail_after_flush)
    assert reached == [True] and response.status_code == 503 and events == []
    assert admin.get(report).headers["etag"] == tag
    assert _ok(admin.get(path))["state"] == "live"
    with case.world.session(org) as db:
        assert db.get(CommsMessage, UUID(message["id"])).mutation_generation == 0


def test_private_report_action_rechecks_admin_after_source_lock_wait(message_routes):
    case, org = message_routes, message_routes.world.first
    conversation, message_id = case.private_conversations()["channel"]
    peer, admin = case.client(org.peer, org.id), case.client(org.author, org.id)
    path = f"/api/comms/conversations/{conversation}/messages/{message_id}"
    assert peer.post(path + "/reports", json={"reason": "Private"}).status_code == 204
    report_id = _ok(admin.get("/api/comms/reports"))["items"][0]["id"]
    report = "/api/comms/reports/" + report_id
    tag = admin.get(report).headers["etag"]
    waiting = Event()

    def observe(_conn, _cursor, statement, _params, _context, _many):
        if "comms_conversation_counters" in statement and "FOR UPDATE" in statement:
            waiting.set()

    with case.world.session(org) as holder:
        holder.scalar(select(CommsConversationCounter).where(
            CommsConversationCounter.conversation_id == conversation,
        ).with_for_update())
        event.listen(case.world.runtime, "before_cursor_execute", observe)
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(admin.post, report + "/message-removal",
                                     headers={"If-Match": tag})
                try:
                    assert waiting.wait(10), "Request never reached the owned source lock"
                    with case.world.session(org) as db:
                        membership = db.scalars(select(Membership).where(
                            Membership.org_id == org.id, Membership.user_id == org.author,
                        )).one()
                        membership.role = "member"
                        db.commit()
                finally:
                    holder.rollback()
                assert future.result(timeout=20).status_code == 404
        finally:
            event.remove(case.world.runtime, "before_cursor_execute", observe)
    assert _ok(peer.get(path))["state"] == "live"


def test_report_rows_are_rls_scoped_and_generation_is_database_bounded(message_routes):
    from sqlalchemy.exc import IntegrityError

    from app.systems.comms.moderation.models import CommsReport

    case, org = message_routes, message_routes.world.first
    admin, _path, report, message = reported(case)
    report_id = UUID(_ok(admin.get(report))["id"])
    with case.world.session(case.world.second) as db:
        assert db.get(CommsReport, report_id) is None
    with case.world.session(org) as db:
        source = db.get(CommsMessage, UUID(message["id"]))
        source.mutation_generation = -1
        with pytest.raises(IntegrityError) as refused:
            db.flush()
        db.rollback()
        assert refused.value.orig.diag.constraint_name == "ck_comms_messages_mutation_generation"
        source = db.get(CommsMessage, UUID(message["id"]))
        source.mutation_generation = 9007199254740992
        with pytest.raises(IntegrityError) as refused:
            db.flush()
        db.rollback()
        assert refused.value.orig.diag.constraint_name == "ck_comms_messages_mutation_generation"
