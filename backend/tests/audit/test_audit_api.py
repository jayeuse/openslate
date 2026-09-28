from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql
from uuid6 import uuid7

from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.manage.audit.router import (
    AuditLogExportRequest,
    AuditLogListRequest,
    export_audit_logs,
    get_audit_log,
    get_audit_logs,
)
from tests.rbac.support import make_user


def test_audit_listing_filters_pagination_detail_and_bounded_export() -> None:
    now = datetime.now(UTC)
    log = AuditLog(
        id=uuid7(),
        action=AuditAction.UPDATE,
        entity_type="users",
        entity_id=uuid7(),
        before={"role_id": "member"},
        after={"role_id": "admin"},
        performed_by=uuid7(),
        created_at=now,
        actor_label="system_migration",
        note="migration",
    )
    database = Mock()
    database.scalars.return_value.all.return_value = [log, log]
    database.scalar.return_value = 3
    database.get.return_value = log
    params = AuditLogListRequest(
        limit=1,
        offset=2,
        search="users",
        sort_by="request_path",
        sort_order="desc",
    )

    result = get_audit_logs(
        make_user("audit-admin"),
        database,
        params,
        action=AuditAction.UPDATE,
        entity_type="users",
        entity_id=log.entity_id,
        performed_by=log.performed_by,
        request_id=uuid7(),
        created_after=now - timedelta(days=1),
        created_before=now + timedelta(days=1),
    )

    assert result.items[0].id == log.id
    assert result.pagination.total == 3
    assert result.pagination.offset == 2
    assert result.pagination.has_more is False
    sql = str(database.scalars.call_args.args[0].compile(dialect=postgresql.dialect()))
    for column in ("action", "entity_type", "entity_id", "performed_by", "request_id"):
        assert f"audit_logs.{column} =" in sql
    assert "audit_logs.created_at >=" in sql
    assert "audit_logs.created_at <=" in sql
    assert "audit_logs.entity_type ILIKE" in sql
    assert "ORDER BY audit_logs.request_path DESC" in sql
    assert "LIMIT" in sql and "OFFSET" in sql
    detail = get_audit_log(log.id, Mock(), database)
    assert detail.before == log.before and detail.after == log.after
    assert detail.actor_label == log.actor_label and detail.note == log.note
    exported = export_audit_logs(Mock(), database, AuditLogExportRequest(limit=1))
    assert len(exported) == 1 and exported[0].id == log.id
    with pytest.raises(ValueError):
        AuditLogExportRequest(limit=101)
    database.get.return_value = None
    with pytest.raises(HTTPException) as error:
        get_audit_log(uuid7(), Mock(), database)
    assert error.value.status_code == 404
