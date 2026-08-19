from datetime import UTC, datetime, timedelta
from uuid import uuid7

import pytest
from fastapi import HTTPException

from app.systems.audit.models import AuditAction, AuditLog
from app.systems.audit.service import decode_cursor, encode_cursor, list_audit_logs


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


def make_log(created_at: datetime) -> AuditLog:
    return AuditLog(
        id=uuid7(),
        action=AuditAction.CREATE,
        table_name="users",
        record_id=uuid7(),
        snapshot={"after": {}},
        created_at=created_at,
    )


def test_cursor_round_trip() -> None:
    log = make_log(datetime.now(UTC))

    cursor = encode_cursor(log)
    created_at, record_id = decode_cursor(cursor)

    assert created_at == log.created_at
    assert record_id == log.id


def test_invalid_cursor_returns_validation_error() -> None:
    with pytest.raises(HTTPException) as error:
        decode_cursor("invalid")

    assert error.value.status_code == 422


def test_list_audit_logs_returns_next_cursor_and_applies_filters() -> None:
    now = datetime.now(UTC)
    logs = [make_log(now), make_log(now - timedelta(minutes=1))]
    first = logs[0]
    database = FakeDatabase(logs)

    items, next_cursor = list_audit_logs(
        database,
        action=AuditAction.CREATE,
        table_name="users",
        record_id=first.record_id,
        performed_by="user:admin",
        request_id=uuid7(),
        created_after=now - timedelta(days=1),
        created_before=now + timedelta(days=1),
        limit=1,
    )

    assert items == [first]
    assert next_cursor is not None


def test_list_audit_logs_handles_cursor_without_next_page() -> None:
    log = make_log(datetime.now(UTC))
    database = FakeDatabase([log])

    items, next_cursor = list_audit_logs(
        database,
        cursor=encode_cursor(log),
        limit=50,
    )

    assert items == [log]
    assert next_cursor is None
