from types import SimpleNamespace

import pytest
from uuid6 import uuid7

from app.systems.audit.context import AuditContext
from app.systems.audit.listeners import (
    PENDING_CHANGES_KEY,
    capture_changes,
    clear_pending_changes,
    create_audit_logs,
    reject_bulk_mutations,
)
from app.systems.audit.models import AuditAction, AuditLog
from app.systems.audit.snapshots import REDACTED
from app.systems.fields.models import Field, FieldType
from app.systems.records.models import Record
from app.systems.users.models import User


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
        "username": "alice",
        "status": "active",
        "role_id": str(user.role_id),
    }
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
        data={redacted_key: "secret", "clear": "visible"},
    )
    record_one.id = uuid7()
    record_two = Record(module_id=module_id, data={redacted_key: "another secret"})
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
    assert record_one.data == {redacted_key: "secret", "clear": "visible"}


def test_rollback_clears_staged_changes() -> None:
    session = FakeSession()
    session.info[PENDING_CHANGES_KEY] = ["pending"]

    clear_pending_changes(session)

    assert PENDING_CHANGES_KEY not in session.info


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
