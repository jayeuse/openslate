"""Guarded conversation purge: real persisted scope, challenge and bounded 10k proof."""

import json
import os
import time
from pathlib import Path
from uuid import UUID

import pytest
from sqlalchemy import event, func, select

from app.core.config import get_settings
from app.systems.access.users.models import Membership
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.messages.models import CommsMessage
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.lifecycle import challenge_verification
from app.systems.sandbox.lifecycle.exceptions import LifecycleInvalidCredentials
from tests.comms.routes.message_support import _ok, send

pytestmark = pytest.mark.integration


@pytest.fixture
def purge_case(message_routes, monkeypatch):
    case, org = message_routes, message_routes.world.first

    class PasswordClient:
        def verify_password(self, email, password):
            if password != "owned-test-password":
                raise LifecycleInvalidCredentials("Invalid confirmation")
            return org.author

    monkeypatch.setattr(
        challenge_verification, "ProviderPasswordGrantClient", lambda _db: PasswordClient(),
    )
    return case


def archived(case):
    org = case.world.first
    admin = case.client(org.author, org.id)
    path = f"/api/comms/conversations/{org.conversation}"
    current = admin.get(path)
    assert current.status_code == 200
    assert admin.post(
        path + "/archive", headers={"If-Match": current.headers["etag"]},
    ).status_code == 200
    return admin, path


def confirmation(preview, **changes):
    return {"token": preview["token"], "confirmation_name": preview["confirmation_name"],
            "password": "owned-test-password", **changes}


def test_purge_requires_archive_admin_flag_password_name_and_current_digest(
    purge_case, monkeypatch,
):
    case, org = purge_case, purge_case.world.first
    admin = case.client(org.author, org.id)
    path = f"/api/comms/conversations/{org.conversation}"
    assert admin.post(path + "/purge/preview").status_code == 409
    admin, path = archived(case)
    assert case.client(org.peer, org.id).post(path + "/purge/preview").status_code == 403
    preview = _ok(admin.post(path + "/purge/preview"))
    assert preview["org_id"] == str(org.id) and preview["message_count"] == 0
    assert preview["max_seq"] == 0 and len(preview["impact_digest"]) == 64
    assert "last_successful_backup_at" in preview
    assert admin.post(
        path + "/purge", json=confirmation(preview, confirmation_name="wrong"),
    ).status_code == 422
    assert admin.post(
        path + "/purge", json=confirmation(preview, password="wrong"),
    ).status_code == 403
    with monkeypatch.context() as patch:
        patch.setattr(get_settings(), "lifecycle_purge_enabled", False)
        assert admin.post(path + "/purge/preview").status_code == 403
    current = admin.get(path)
    assert admin.post(
        path + "/restore", headers={"If-Match": current.headers["etag"]},
    ).status_code == 200
    send(admin, path + "/messages", "New message after preview")
    admin, path = archived(case)
    assert admin.post(path + "/purge", json=confirmation(preview)).status_code == 409
    assert _ok(admin.get(path + "/messages"))["items"][0]["body"] == "New message after preview"


def test_purge_removes_owned_graph_and_reports_without_content_in_audit(
    purge_case, record_property,
):
    case, org = purge_case, purge_case.world.first
    admin = case.client(org.author, org.id)
    peer = case.client(org.peer, org.id)
    path = f"/api/comms/conversations/{org.conversation}"
    source = send(
        admin, path + "/messages", "Purge source canary", mention_user_ids=[str(org.peer)],
    )
    unrelated = send(
        admin, f"/api/comms/conversations/{org.other_conversation}/messages", "Preserved source",
    )
    retained_broadcast = send(
        admin,
        f"/api/comms/conversations/{org.other_conversation}/threads/{unrelated['id']}/replies",
        "Preserved broadcast", also_send_to_channel=True,
    )
    assert peer.post(
        path + f"/messages/{source['id']}/reports", json={"reason": "Purge reason canary"},
    ).status_code == 204
    report_id = _ok(admin.get("/api/comms/reports"))["items"][0]["id"]
    send(peer, path + f"/threads/{source['id']}/replies", "Purge reply canary")
    broadcast = send(
        peer, path + f"/threads/{source['id']}/replies", "Purge broadcast canary",
        also_send_to_channel=True,
    )
    assert broadcast["parent_id"] == source["id"] and broadcast["also_send_to_channel"] is True
    admin, path = archived(case)
    preview = _ok(admin.post(path + "/purge/preview"))
    assert preview["message_count"] == preview["max_seq"] == 3
    events = []
    admin.app.state.comms_publisher.submit = lambda rows: events.extend(rows)
    def record_constraint(error_context):
        diagnostic = getattr(error_context.original_exception, "diag", None)
        if diagnostic is not None and diagnostic.constraint_name:
            record_property("purge_database_constraint", diagnostic.constraint_name)

    event.listen(case.world.runtime, "handle_error", record_constraint)
    try:
        result = _ok(admin.post(path + "/purge", json=confirmation(preview)))
    finally:
        event.remove(case.world.runtime, "handle_error", record_constraint)
    assert result["purged_message_count"] == 3 and result["purged_file_count"] == 0
    assert UUID(result["operation_id"])
    assert admin.get(path).status_code == 404
    assert admin.get("/api/comms/reports/" + report_id).status_code == 404
    assert admin.post(path + "/purge", json=confirmation(preview)).status_code != 200
    assert case.client(case.world.second.author, case.world.second.id).get(
        f"/api/comms/conversations/{case.world.second.conversation}").status_code == 200
    assert events and all(
        row["event"] in {"structure", "grants"} and row["payload"] == {} for row in events
    )
    with case.world.session(org) as db:
        assert db.scalar(select(func.count()).select_from(CommsMessage).where(
            CommsMessage.conversation_id == org.conversation,
        )) == 0
        assert db.get(CommsMessage, UUID(unrelated["id"])).body == "Preserved source"
        retained = db.get(CommsMessage, UUID(retained_broadcast["id"]))
        assert retained.body == "Preserved broadcast"
        assert retained.parent_id == UUID(unrelated["id"]) and retained.also_send_to_channel is True
        audits = db.scalars(select(AuditLog).where(AuditLog.org_id == org.id)).all()
        assert any(row.action == "delete" and row.entity_id == UUID(source["id"]) for row in audits)
        serialized = json.dumps([(row.before, row.after) for row in audits], default=str)
        assert all(canary not in serialized for canary in (
            "Purge source canary", "Purge reply canary", "Purge broadcast canary",
            "Purge reason canary",
        ))


def test_password_success_does_not_preserve_admin_authority_after_demotion(purge_case, monkeypatch):
    case, org = purge_case, purge_case.world.first
    admin, path = archived(case)
    preview = _ok(admin.post(path + "/purge/preview"))
    original = challenge_verification.ProviderPasswordGrantClient

    class DemotingClient:
        def verify_password(self, email, password):
            result = original(None).verify_password(email, password)
            with case.world.session(org) as db:
                row = db.scalars(select(Membership).where(
                    Membership.org_id == org.id, Membership.user_id == org.author,
                )).one()
                row.role = "member"
                db.commit()
            return result

    monkeypatch.setattr(
        challenge_verification, "ProviderPasswordGrantClient", lambda _db: DemotingClient(),
    )
    assert admin.post(path + "/purge", json=confirmation(preview)).status_code == 403
    with case.world.session(org) as db:
        assert db.get(CommsConversation, org.conversation) is not None


def test_ten_thousand_message_purge_completes_within_statement_timeout(purge_case, record_property):
    case = purge_case
    case.seed_large_history(10_000)
    admin, path = archived(case)
    preview = _ok(admin.post(path + "/purge/preview"))
    assert preview["message_count"] == preview["max_seq"] == 10_000
    starts, durations = [], []

    def before(*_args):
        starts.append(time.monotonic())

    def after(*_args):
        durations.append(time.monotonic() - starts.pop())

    event.listen(case.world.runtime, "before_cursor_execute", before)
    event.listen(case.world.runtime, "after_cursor_execute", after)
    started = time.monotonic()
    try:
        result = admin.post(path + "/purge", json=confirmation(preview))
    finally:
        elapsed = time.monotonic() - started
        event.remove(case.world.runtime, "before_cursor_execute", before)
        event.remove(case.world.runtime, "after_cursor_execute", after)
    record_property("purge_messages", 10_000)
    record_property("purge_seconds", elapsed)
    record_property("max_statement_seconds", max(durations))
    record_property("statement_count", len(durations))
    record_property("total_statement_seconds", sum(durations))
    record_property("statement_timeout_ms", get_settings().database_statement_timeout_ms)
    artifact = Path("test-results/s22") / os.environ["OPENSLATE_FULLSTACK_RUN_ID"]
    artifact.mkdir(parents=True, exist_ok=True)
    (artifact / "purge-10000.json").write_text(json.dumps({
        "message_count": 10_000, "elapsed_seconds": elapsed,
        "max_statement_seconds": max(durations), "statement_count": len(durations),
        "total_statement_seconds": sum(durations),
        "statement_timeout_ms": get_settings().database_statement_timeout_ms,
        "http_status": result.status_code,
    }, indent=2) + "\n")
    assert _ok(result)["purged_message_count"] == 10_000
    assert elapsed * 1000 <= get_settings().database_statement_timeout_ms
    assert admin.get(path).status_code == 404
