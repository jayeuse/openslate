from types import SimpleNamespace
from uuid import uuid7

import pytest

from app.systems.audit.context import AuditContext
from app.systems.audit.listeners import (
    PENDING_CHANGES_KEY,
    capture_changes,
    clear_pending_changes,
    create_audit_logs,
    reject_bulk_mutations,
)
from app.systems.audit.models import AuditAction, AuditLog
from app.systems.users.models import User


class FakeSession:
    def __init__(self) -> None:
        self.info: dict[str, object] = {"audit_context": AuditContext(performed_by="anonymous")}
        self.new: list[object] = []
        self.dirty: list[object] = []
        self.deleted: list[object] = []
        self.added: list[object] = []

    def add(self, instance: object) -> None:
        self.added.append(instance)


def test_create_listener_stages_and_writes_create_log() -> None:
    session = FakeSession()
    user = User(username="alice", password_hash="hash")
    user.id = uuid7()
    session.new = [user]

    capture_changes(session, None, None)
    create_audit_logs(session, None)

    assert len(session.added) == 1
    audit_log = session.added[0]
    assert isinstance(audit_log, AuditLog)
    assert audit_log.action is AuditAction.CREATE
    assert audit_log.record_id == user.id
    assert audit_log.performed_by == "anonymous"
    assert audit_log.snapshot["after"]["password_hash"] == "[REDACTED]"


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
        table_name="users",
        record_id=uuid7(),
        snapshot={"after": {}},
    )
    session.dirty = [log]

    with pytest.raises(RuntimeError, match="immutable"):
        capture_changes(session, None, None)
