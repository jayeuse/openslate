from datetime import UTC, datetime, timedelta
from uuid import uuid7

from sqlalchemy.dialects import postgresql

from app.common.listing import StandardListRequest
from app.systems.audit.models import AuditAction, AuditLog
from app.systems.audit.service import AuditLogSortField, list_audit_logs


class ScalarResult:
    def __init__(self, logs: list[AuditLog]) -> None:
        self.logs = logs

    def all(self) -> list[AuditLog]:
        return self.logs


class FakeDatabase:
    def __init__(self, logs: list[AuditLog], total: int | None = None) -> None:
        self.logs = logs
        self.total = len(logs) if total is None else total
        self.count_statement = None
        self.items_statement = None

    def scalar(self, query) -> int:
        self.count_statement = query
        return self.total

    def scalars(self, query) -> ScalarResult:
        self.items_statement = query
        return ScalarResult(self.logs)


def make_log(created_at: datetime) -> AuditLog:
    return AuditLog(
        id=uuid7(),
        action=AuditAction.CREATE,
        entity_type="users",
        entity_id=uuid7(),
        after={},
        created_at=created_at,
    )


def test_list_audit_logs_returns_offset_pagination_and_applies_filters() -> None:
    now = datetime.now(UTC)
    logs = [make_log(now), make_log(now - timedelta(minutes=1))]
    first = logs[0]
    database = FakeDatabase([first], total=3)

    result = list_audit_logs(
        database,
        StandardListRequest[AuditLogSortField](limit=1, offset=2),
        action=AuditAction.CREATE,
        entity_type="users",
        entity_id=first.entity_id,
        performed_by=uuid7(),
        request_id=uuid7(),
        created_after=now - timedelta(days=1),
        created_before=now + timedelta(days=1),
    )

    assert result.items == [first]
    assert result.pagination.limit == 1
    assert result.pagination.offset == 2
    assert result.pagination.total == 3
    assert result.pagination.has_more is False

    sql = str(database.items_statement.compile(dialect=postgresql.dialect()))
    assert "audit_logs.action =" in sql
    assert "audit_logs.entity_type =" in sql
    assert "audit_logs.entity_id =" in sql
    assert "audit_logs.performed_by =" in sql
    assert "audit_logs.request_id =" in sql
    assert "audit_logs.created_at >=" in sql
    assert "audit_logs.created_at <=" in sql
    assert "LIMIT" in sql
    assert "OFFSET" in sql


def test_list_audit_logs_searches_and_sorts_without_joining() -> None:
    database = FakeDatabase([])

    list_audit_logs(
        database,
        StandardListRequest[AuditLogSortField](
            search="users",
            sort_by=AuditLogSortField.REQUEST_PATH,
            sort_order="desc",
        ),
    )

    sql = str(database.items_statement.compile(dialect=postgresql.dialect()))
    assert "audit_logs.entity_type ILIKE" in sql
    assert "audit_logs.request_path ILIKE" in sql
    assert "JOIN" not in sql
    assert "ORDER BY audit_logs.request_path DESC" in sql
