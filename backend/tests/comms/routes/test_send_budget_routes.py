"""HTTP send limits, fresh policy after waits, and transactional failure behavior."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from time import perf_counter

import pytest
from sqlalchemy import event, select, text

from app.core.database.session import AuditSession
from app.systems.access.users.models import User
from app.systems.comms.messages.models import CommsConversationCounter, CommsMessageRevision
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.comms.conftest import NOW
from tests.comms.routes.message_support import (
    _edit,
    _error,
    _ok,
    _payload,
    _record_performance,
    _root,
)
from tests.comms.test_message_transactions import _stored_state
from tests.conftest import create_member
from tests.race_support import WAIT, backend_pid, wait_until_blocked_by

pytestmark = pytest.mark.integration


def test_thirty_serial_sends_record_latency_without_bypassing_the_author_budget(
    message_routes,
    record_property,
):
    case, org = message_routes, message_routes.world.first
    clients = [case.client(org.author, org.id), case.client(org.peer, org.id)]
    startup = []
    for client in clients:
        started = perf_counter()
        assert client.get("/api/health").status_code == 200
        startup.append((perf_counter() - started) * 1000)
    timings = []
    for index in range(30):
        started = perf_counter()
        response = clients[index % 2].post(f"{_root(org.conversation)}/messages", json=_payload())
        timings.append((perf_counter() - started) * 1000)
        assert _ok(response, 201)["seq"] == index + 1
    record_property("send_request_ms", timings)
    record_property("send_request_p95_ms", sorted(timings)[28])
    record_property("send_samples_per_author", 15)
    record_property("send_application_startup_ms", startup)
    _record_performance("send", timings, startup_ms=startup)


def test_public_budget_spans_conversations_but_not_other_actors_or_organizations(
    message_routes,
    budget_clock,
):
    case, org = message_routes, message_routes.world.first
    api = case.client(org.author, org.id)
    original = _payload()
    path = f"{_root(org.conversation)}/messages"
    first = _ok(api.post(path, json=original), 201)
    for number in range(19):
        target = org.other_conversation if number % 2 == 0 else org.conversation
        _ok(api.post(f"{_root(target)}/messages", json=_payload()), 201)
    before = _stored_state(case.world)
    limited = api.post(path, json=_payload())
    _error(limited, 429, "comms_rate_limited")
    assert limited.headers["retry-after"] == "10"
    assert _ok(api.post(path, json=original)) == first
    _error(
        api.post(path, json=original | {"body": "Changed original"}),
        409,
        "comms_idempotency_mismatch",
    )
    assert _stored_state(case.world) == before
    peer = case.client(org.peer, org.id)
    _ok(peer.post(path, json=_payload()), 201)
    other = case.world.second
    with case.world.session(other) as db:
        create_member(
            db, db.get(WorkspaceProfile, other.id), "member", user=db.get(User, org.author)
        )
        db.commit()
    other_path = f"{_root(other.conversation)}/messages"
    switched = api.post(other_path, headers={"X-Org": str(other.id)}, json=_payload())
    assert _ok(switched, 201)["author_id"] == str(org.author)
    _error(api.post(path, json=_payload()), 429, "comms_rate_limited")
    budget_clock[0] = NOW + timedelta(seconds=10)
    assert api.post(path, json=_payload()).status_code == 201


@pytest.mark.parametrize("policy_change", ["membership", "locked"])
def test_http_send_authorizes_current_policy_after_waiting_for_counter(
    message_routes,
    policy_change,
):
    case, org = message_routes, message_routes.world.first
    api = case.client(org.peer, org.id)
    path = f"{_root(org.other_conversation)}/messages"
    with case.world.session(org) as holder:
        holder.scalar(
            select(CommsConversationCounter)
            .where(
                CommsConversationCounter.org_id == org.id,
                CommsConversationCounter.conversation_id == org.other_conversation,
            )
            .with_for_update()
        )
        with ThreadPoolExecutor(max_workers=1) as workers:
            pending = workers.submit(api.post, path, json=_payload())
            try:
                assert wait_until_blocked_by(case.world.owner, backend_pid(holder))
                if policy_change == "membership":
                    case.hide_other_conversation()
                else:
                    case.settings({"locked": True})
                before = _stored_state(case.world)
            finally:
                holder.rollback()
            response = pending.result(timeout=WAIT)
    status, code = (
        (404, "comms_not_found")
        if policy_change == "membership"
        else (
            403,
            "comms_post_denied",
        )
    )
    _error(response, status, code)
    assert _stored_state(case.world) == before


@pytest.mark.parametrize("method", ["POST", "PATCH", "DELETE"])
def test_failed_message_write_rolls_back_and_hides_database_errors(
    message_routes,
    budget_clock,
    method,
):
    case, org = message_routes, message_routes.world.first
    api = case.client(org.peer, org.id)
    collection = f"{_root(org.conversation)}/messages"
    original = _ok(api.post(collection, json=_payload()), 201)
    path = collection if method == "POST" else f"{collection}/{original['id']}"
    options = (
        {"json": _payload()} if method == "POST" else {"json": _edit()} if method == "PATCH" else {}
    )
    before, reached = _stored_state(case.world), []

    def fail_before_commit(session):
        context = session.info.get(AUDIT_CONTEXT_KEY)
        if session.get_bind() is not case.world.runtime or context is None:
            return
        if context.request_method != method or context.request_path != path:
            return
        session.flush()
        reached.append(True)
        assert _stored_state(case.world) == before
        session.connection().execute(
            text("SELECT 1 / 0")
        )  # Real PostgreSQL failure, no fake response.

    event.listen(AuditSession, "before_commit", fail_before_commit)
    try:
        response = api.request(method, path, **options)
    finally:
        event.remove(AuditSession, "before_commit", fail_before_commit)
    assert reached == [True]
    _error(response, 503, "comms_unavailable")
    assert "division by zero" not in response.text and "SELECT 1 / 0" not in response.text
    assert _stored_state(case.world) == before
    with case.world.session(org) as db:
        assert (
            db.scalars(
                select(CommsMessageRevision.id).where(
                    CommsMessageRevision.org_id == org.id,
                )
            ).all()
            == []
        )
    assert api.request(method, path, **options).status_code == (201 if method == "POST" else 200)


@pytest.mark.parametrize("view", ["bootstrap", "history"])
def test_reads_do_not_mix_new_messages_with_an_older_high_water(message_routes, view):
    case, org = message_routes, message_routes.world.first
    reader, writer = case.client(org.peer, org.id), case.client(org.author, org.id)
    collection = f"{_root(org.conversation)}/messages"
    path = "/api/comms/bootstrap" if view == "bootstrap" else collection
    captured, release = Event(), Event()

    def hold_snapshot(_connection, _cursor, statement, _parameters, _context, _many):
        if captured.is_set() or "comms_conversation_counters.last_seq" not in statement:
            return
        if "FOR UPDATE" in statement:
            return
        captured.set()
        assert release.wait(WAIT)

    event.listen(case.world.runtime, "after_cursor_execute", hold_snapshot)
    try:
        with ThreadPoolExecutor(max_workers=1) as workers:
            pending = workers.submit(reader.get, path)
            try:
                assert captured.wait(WAIT)
                _ok(writer.post(collection, json=_payload()), 201)
            finally:
                release.set()
            response = _ok(pending.result(timeout=WAIT))
    finally:
        release.set()
        event.remove(case.world.runtime, "after_cursor_execute", hold_snapshot)
    if view == "bootstrap":
        summary = next(
            row
            for row in response["conversations"]
            if row["conversation"]["id"] == str(org.conversation)
        )
        assert (
            summary["high_water_seq"],
            summary["unread_count"],
            summary["first_unread_seq"],
        ) == (
            0,
            0,
            None,
        )
    else:
        assert response["pagination"]["high_water_seq"] == 0
        assert response["items"] == []
    assert _ok(reader.get(collection))["pagination"]["high_water_seq"] == 1
