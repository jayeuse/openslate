from datetime import UTC, datetime
from uuid import uuid7

import pytest
from fastapi import HTTPException

from app.systems.audit.models import AuditAction, AuditLog
from app.systems.audit.router import get_audit_log, get_audit_logs
from app.systems.users.models import Role, User, UserRole


class ScalarResult:
    def __init__(self, logs: list[AuditLog]) -> None:
        self.logs = logs

    def all(self) -> list[AuditLog]:
        return self.logs


class FakeDatabase:
    def __init__(self, logs: list[AuditLog]) -> None:
        self.logs = logs

    def scalars(self, query) -> ScalarResult:
        return ScalarResult(self.logs)

    def get(self, model, identifier):
        return next((log for log in self.logs if log.id == identifier), None)


def make_log() -> AuditLog:
    return AuditLog(
        id=uuid7(),
        action=AuditAction.UPDATE,
        entity_type="users",
        entity_id=uuid7(),
        before={"role_id": "member"},
        after={"role_id": "admin"},
        performed_by=uuid7(),
        created_at=datetime.now(UTC),
    )


def test_admin_can_list_and_retrieve_audit_logs() -> None:
    log = make_log()
    database = FakeDatabase([log])
    admin = User(
        username="admin",
        password_hash="hash",
        role=Role(role=UserRole.ADMIN, permissions={}),
    )

    listing = get_audit_logs(admin, database)
    detail = get_audit_log(log.id, admin, database)

    assert listing.items[0].id == log.id
    assert detail.before == log.before
    assert detail.after == log.after


def test_missing_audit_log_returns_not_found() -> None:
    admin = User(
        username="admin",
        password_hash="hash",
        role=Role(role=UserRole.ADMIN, permissions={}),
    )

    with pytest.raises(HTTPException) as error:
        get_audit_log(uuid7(), admin, FakeDatabase([]))

    assert error.value.status_code == 404
