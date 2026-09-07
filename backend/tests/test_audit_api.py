from datetime import UTC, datetime
from uuid import uuid7

import pytest
from fastapi import HTTPException

from app.common.listing import DeletedFilter
from app.systems.audit.models import AuditAction, AuditLog
from app.systems.audit.router import (
    AuditLogExportRequest,
    AuditLogListRequest,
    export_audit_logs,
    get_audit_log,
    get_audit_logs,
)
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

    def scalar(self, query) -> int:
        return len(self.logs)

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
        actor_label="system_migration",
        note="migration note",
    )


def test_admin_can_list_and_retrieve_audit_logs() -> None:
    log = make_log()
    database = FakeDatabase([log])
    admin = User(
        id=uuid7(),
        email="admin@example.com",
        username="admin",
        status="active",
        role_id=uuid7(),
        role=Role(role=UserRole.ADMIN, permissions={}),
    )

    listing = get_audit_logs(admin, database, AuditLogListRequest())
    detail = get_audit_log(log.id, admin, database)

    assert listing.items[0].id == log.id
    assert listing.pagination.total == 1
    assert detail.before == log.before
    assert detail.after == log.after
    assert detail.actor_label == log.actor_label
    assert detail.note == log.note


def test_admin_can_export_audit_logs_with_a_bounded_bare_list() -> None:
    logs = [make_log(), make_log()]
    database = FakeDatabase(logs)
    admin = User(
        id=uuid7(),
        email="admin@example.com",
        username="admin",
        status="active",
        role_id=uuid7(),
        role=Role(role=UserRole.ADMIN, permissions={}),
    )

    exported = export_audit_logs(admin, database, AuditLogExportRequest(limit=1))

    assert len(exported) == 1
    assert exported[0].id == logs[0].id
    assert AuditLogExportRequest().limit == 100
    with pytest.raises(ValueError):
        AuditLogExportRequest(limit=101)


@pytest.mark.parametrize("deleted", [DeletedFilter.INCLUDE, DeletedFilter.ONLY])
def test_audit_list_rejects_deleted_filters(deleted: DeletedFilter) -> None:
    admin = User(
        id=uuid7(),
        email="admin@example.com",
        username="admin",
        status="active",
        role_id=uuid7(),
        role=Role(role=UserRole.ADMIN, permissions={}),
    )

    with pytest.raises(HTTPException) as error:
        get_audit_logs(
            admin,
            FakeDatabase([]),
            AuditLogListRequest(deleted=deleted),
        )

    assert error.value.status_code == 422


def test_missing_audit_log_returns_not_found() -> None:
    admin = User(
        id=uuid7(),
        email="admin@example.com",
        username="admin",
        status="active",
        role_id=uuid7(),
        role=Role(role=UserRole.ADMIN, permissions={}),
    )

    with pytest.raises(HTTPException) as error:
        get_audit_log(uuid7(), admin, FakeDatabase([]))

    assert error.value.status_code == 404


def test_audit_list_uses_flat_standard_query_parameters() -> None:
    from app.main import app

    operation = app.openapi()["paths"]["/api/audit-logs"]["get"]
    parameter_names = {parameter["name"] for parameter in operation["parameters"]}

    assert "params" not in parameter_names
    assert {"limit", "offset", "sort_by", "sort_order", "search", "deleted"} <= parameter_names
    assert "cursor" not in parameter_names

    export_operation = app.openapi()["paths"]["/api/audit-logs/export"]["get"]
    export_parameter_names = {parameter["name"] for parameter in export_operation["parameters"]}
    assert {"limit", "offset", "sort_by", "sort_order", "search", "deleted"} <= (
        export_parameter_names
    )
    assert "audit_log_id" not in export_parameter_names
