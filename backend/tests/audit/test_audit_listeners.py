from secrets import token_urlsafe
from types import SimpleNamespace

import pytest
from uuid6 import uuid7

from app.systems.access.users.models import User
from app.systems.access.users.permissions import Capability
from app.systems.manage.audit.context import AuditContext
from app.systems.manage.audit.listeners import (
    PENDING_CHANGES_KEY,
    REALTIME_INVALIDATION_KEY,
    broadcast_committed_changes,
    capture_changes,
    clear_pending_changes,
    create_audit_logs,
    reject_bulk_mutations,
)
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.manage.audit.snapshots import REDACTED
from app.systems.platform.events.models import InvalidationEvent
from app.systems.platform.scheduling.models import InAppNotification
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.records.models import Record

FIRST_RECORD_CANARY = token_urlsafe(32)
SECOND_RECORD_CANARY = token_urlsafe(32)


class FakeSession:
    def __init__(self) -> None:
        self.info: dict[str, object] = {"audit_context": AuditContext()}
        self.new: list[object] = []
        self.dirty: list[object] = []
        self.deleted: list[object] = []
        self.added: list[object] = []
        self.scalar_rows: list[object] = []
        self.scalars_calls = 0

    def add(self, instance: object) -> None:
        self.added.append(instance)

    def scalars(self, query) -> object:
        self.scalars_calls += 1
        return SimpleNamespace(all=lambda: self.scalar_rows)


def test_create_listener_stages_and_writes_create_log() -> None:
    session = FakeSession()
    user = User(
        id=uuid7(),
        email="alice@example.com",
        username="alice",
        status="active",
        role_id=uuid7(),
    )
    session.new = [user]

    capture_changes(session, None, None)
    create_audit_logs(session, None)

    assert len(session.added) == 1
    audit_log = session.added[0]
    assert isinstance(audit_log, AuditLog)
    assert audit_log.action is AuditAction.CREATE
    assert audit_log.entity_type == "users"
    assert audit_log.entity_id == user.id
    assert audit_log.performed_by is None
    assert audit_log.before is None
    assert audit_log.after == {
        "email": "alice@example.com",
        "supabase_user_id": None,
        "provider_invitation_operation_id": None,
        "username": "alice",
        "display_name": None,
        "identity_kind": None,
        "job_title": None,
        "sponsor_user_id": None,
        "expires_at": None,
        "status": "active",
        "role_id": str(user.role_id),
    }
    assert session.info[REALTIME_INVALIDATION_KEY] == [
        InvalidationEvent(entity="users", entity_id=user.id, administrators_only=True)
    ]
    assert "password_hash" not in audit_log.after


def test_record_create_snapshots_redact_current_dynamic_fields_in_one_query() -> None:
    module_id = uuid7()
    redacted_field = Field(
        module_id=module_id,
        name="Renamed secret",
        type=FieldType.TEXT,
        position=0,
        audit_redacted=True,
        is_deleted=True,
    )
    redacted_field.id = uuid7()
    redacted_key = str(redacted_field.id)
    record_one = Record(
        module_id=module_id,
        data={redacted_key: FIRST_RECORD_CANARY, "clear": "visible"},
    )
    record_one.id = uuid7()
    record_two = Record(module_id=module_id, data={redacted_key: SECOND_RECORD_CANARY})
    record_two.id = uuid7()
    session = FakeSession()
    session.new = [record_one, record_two]
    session.scalar_rows = [redacted_field]

    capture_changes(session, None, None)
    create_audit_logs(session, None)

    assert session.scalars_calls == 1
    logs = [entry for entry in session.added if isinstance(entry, AuditLog)]
    assert len(logs) == 2
    assert logs[0].after == {
        "module_id": str(module_id),
        "data": {redacted_key: REDACTED, "clear": "visible"},
    }
    assert logs[1].after == {
        "module_id": str(module_id),
        "data": {redacted_key: REDACTED},
    }
    assert record_one.data == {redacted_key: FIRST_RECORD_CANARY, "clear": "visible"}


def test_rollback_clears_staged_changes() -> None:
    session = FakeSession()
    session.info[PENDING_CHANGES_KEY] = ["pending"]

    clear_pending_changes(session)

    assert PENDING_CHANGES_KEY not in session.info


def test_only_a_successful_commit_publishes_the_staged_opaque_invalidations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = FakeSession()
    session.info[REALTIME_INVALIDATION_KEY] = [
        InvalidationEvent(entity="records", capability=Capability.RECORDS_READ),
    ]
    published: list[InvalidationEvent] = []
    monkeypatch.setattr(
        "app.systems.manage.audit.listeners.publish_invalidations",
        lambda events: published.extend(events),
    )

    broadcast_committed_changes(session)
    broadcast_committed_changes(session)

    assert published == [InvalidationEvent(entity="records", capability=Capability.RECORDS_READ)]
    assert REALTIME_INVALIDATION_KEY not in session.info


def test_rollback_discards_staged_invalidations_without_publishing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = FakeSession()
    session.info[REALTIME_INVALIDATION_KEY] = [InvalidationEvent(entity="records")]
    published: list[InvalidationEvent] = []
    monkeypatch.setattr(
        "app.systems.manage.audit.listeners.publish_invalidations",
        lambda events: published.extend(events),
    )

    clear_pending_changes(session)
    broadcast_committed_changes(session)

    assert published == []


def test_commit_deduplicates_staged_invalidations_before_one_publish_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    event = InvalidationEvent(entity="records", capability=Capability.RECORDS_READ)
    session = FakeSession()
    session.info[REALTIME_INVALIDATION_KEY] = [event, event]
    calls: list[tuple[InvalidationEvent, ...]] = []
    monkeypatch.setattr(
        "app.systems.manage.audit.listeners.publish_invalidations",
        lambda events: calls.append(tuple(events)),
    )

    broadcast_committed_changes(session)

    assert calls == [(event,)]


def test_audit_stages_recipient_from_notification_row_and_suppresses_report_subjects() -> None:
    from app.systems.openview.reports.models import Report

    recipient_id = uuid7()
    notification = InAppNotification(work_id=uuid7(), recipient_id=recipient_id)
    notification.id = uuid7()
    report = Report(owner_id=uuid7(), module_id=uuid7(), name="Private", recipe={})
    report.id = uuid7()
    session = FakeSession()
    session.new = [notification, report]

    capture_changes(session, None, None)
    create_audit_logs(session, None)

    assert session.info[REALTIME_INVALIDATION_KEY] == [
        InvalidationEvent(entity="in_app_notifications", recipient_id=recipient_id)
    ]
    assert {entry.entity_type for entry in session.added if isinstance(entry, AuditLog)} == {
        "in_app_notifications",
        "reports",
    }


def test_bulk_mutations_are_rejected() -> None:
    with pytest.raises(RuntimeError, match="Bulk or raw ORM mutations"):
        reject_bulk_mutations(SimpleNamespace(is_select=False, is_update=True, is_delete=False))


def test_audit_logs_are_immutable() -> None:
    session = FakeSession()
    log = AuditLog(
        action=AuditAction.CREATE,
        entity_type="users",
        entity_id=uuid7(),
        after={},
    )
    session.dirty = [log]

    with pytest.raises(RuntimeError, match="immutable"):
        capture_changes(session, None, None)
