"""Stored references and transaction boundaries cannot be proved by isolated mocks."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID

import pytest
from sqlalchemy import event, select, text
from sqlalchemy.exc import IntegrityError, OperationalError
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.comms.messages.models import CommsMessage
from app.systems.platform.scheduling.models import InAppNotification
from tests.comms.routes.message_support import _payload
from tests.comms.routes.test_comms_notification_routes import inbox_client, notices

pytestmark = pytest.mark.integration


def test_notification_rows_and_events_share_send_commit_replay_and_rollback(message_routes):
    case, org = message_routes, message_routes.world.first
    author, peer = inbox_client(case, org.author, org.id), inbox_client(case, org.peer, org.id)
    events, committed_at_publication = [], []

    def published(rows):
        with case.world.session(org) as db:
            committed_at_publication.extend(db.scalars(select(InAppNotification.id).where(
                InAppNotification.org_id == org.id,
            )))
        events.extend(row for row in rows if row["event"] == "notification")

    author.app.state.comms_publisher.submit = published
    path = f"/api/comms/conversations/{org.conversation}/messages"
    payload = _payload("Atomic private source") | {"mention_user_ids": [str(org.peer)]}
    first = author.post(path, json=payload)
    assert first.status_code == 201
    inbox = notices(peer)
    assert len(inbox) == 1
    identity = UUID(inbox[0]["id"])
    assert committed_at_publication == [identity]
    assert len(events) == 1 and events[0]["payload"] == {"id": str(identity)}
    assert author.post(path, json=payload).status_code == 200
    assert len(notices(peer)) == len(events) == 1
    failures = []

    def fail_after_inserts(db, _flush_context):
        if db.get_bind() is case.world.runtime and any(
            isinstance(row, InAppNotification) for row in db.new
        ):
            failures.append(True)
            raise OperationalError("controlled notification flush failure", {}, RuntimeError())

    event.listen(AuditSession, "after_flush", fail_after_inserts)
    try:
        failed = author.post(path, json={**payload, "client_key": str(uuid7())})
    finally:
        event.remove(AuditSession, "after_flush", fail_after_inserts)
    assert failures == [True] and failed.status_code == 503
    assert len(events) == 1 and [row["id"] for row in notices(peer)] == [str(identity)]
    with case.world.session(org) as db:
        assert list(db.scalars(select(CommsMessage.id))) == [UUID(first.json()["id"])]
    # Two concurrent retries converge to one original row/event, not two winners.
    gate, concurrent_events = Barrier(2), []
    clients = [case.client(org.author, org.id, request_gate=gate) for _ in range(2)]
    for client in clients:
        client.app.state.comms_publisher.submit = lambda rows: concurrent_events.extend(
            row for row in rows if row["event"] == "notification"
        )
    payload["client_key"] = str(uuid7())
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(client.post, path, json=payload) for client in clients]
        replies = [future.result(timeout=30) for future in futures]
    assert sorted(response.status_code for response in replies) == [200, 201]
    assert len(notices(peer)) == 2 and len(concurrent_events) == 1


def test_notification_reference_and_one_recipient_message_constraints(message_routes):
    case, org = message_routes, message_routes.world.first
    author, peer = inbox_client(case, org.author, org.id), inbox_client(case, org.peer, org.id)
    response = author.post(f"/api/comms/conversations/{org.conversation}/messages", json={
        **_payload(), "mention_user_ids": [str(org.peer)],
    })
    assert response.status_code == 201
    rows = notices(peer)
    assert len(rows) == 1
    source = UUID(response.json()["id"])
    base = {
        "id": uuid7(), "org_id": org.id, "recipient_id": org.peer,
        "kind": "comms-keyword", "subject_type": "comms_message", "subject_id": source,
        "comms_conversation_id": org.conversation,
    }
    cases = [
        ({}, "uq_in_app_notifications_comms_recipient"),
        ({"subject_type": "record", "comms_conversation_id": None},
         "ck_in_app_notifications_reference"),
        ({"org_id": None}, "ck_in_app_notifications_organization"),
        ({"comms_conversation_id": None}, "ck_in_app_notifications_comms_reference"),
        ({"work_id": uuid7()}, "ck_in_app_notifications_reference"),
        ({"subject_id": uuid7(), "comms_conversation_id": case.world.second.conversation},
         "fk_in_app_notifications_comms_conversation"),
    ]
    with case.world.owner.connect() as connection:
        for values, constraint in cases:
            with pytest.raises(IntegrityError) as refused:
                connection.execute(InAppNotification.__table__.insert().values(base | values))
            connection.rollback()
            assert refused.value.orig.diag.constraint_name == constraint
        assert connection.scalar(text(
            "SELECT character_maximum_length FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name='in_app_notifications' "
            "AND column_name='subject_type'",
        )) == 24
