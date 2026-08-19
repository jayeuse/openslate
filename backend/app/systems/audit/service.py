from datetime import datetime
from enum import StrEnum
from typing import Any, cast
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.listing import (
    ListQueryResult,
    ListQuerySpec,
    StandardListRequest,
    execute_standard_list,
)
from app.systems.audit.models import AuditAction, AuditLog


class AuditLogSortField(StrEnum):
    ACTION = "action"
    CREATED_AT = "created_at"
    ENTITY_TYPE = "entity_type"
    REQUEST_PATH = "request_path"


AUDIT_LOG_LIST_SPEC = ListQuerySpec(
    sort_fields={
        AuditLogSortField.ACTION: cast(ColumnElement[Any], AuditLog.action),
        AuditLogSortField.CREATED_AT: cast(ColumnElement[Any], AuditLog.created_at),
        AuditLogSortField.ENTITY_TYPE: cast(ColumnElement[Any], AuditLog.entity_type),
        AuditLogSortField.REQUEST_PATH: cast(ColumnElement[Any], AuditLog.request_path),
    },
    default_sort=AuditLogSortField.CREATED_AT,
    tie_breaker=cast(ColumnElement[Any], AuditLog.id),
    search_fields=(
        cast(ColumnElement[str], AuditLog.entity_type),
        cast(ColumnElement[str], AuditLog.request_path),
    ),
)


def list_audit_logs(
    db: Session,
    params: StandardListRequest[AuditLogSortField],
    *,
    action: AuditAction | None = None,
    entity_type: str | None = None,
    entity_id: UUID | None = None,
    performed_by: UUID | None = None,
    request_id: UUID | None = None,
    created_after: datetime | None = None,
    created_before: datetime | None = None,
) -> ListQueryResult[AuditLog]:
    conditions: list[ColumnElement[bool]] = []
    if action is not None:
        conditions.append(AuditLog.action == action)
    if entity_type is not None:
        conditions.append(AuditLog.entity_type == entity_type)
    if entity_id is not None:
        conditions.append(AuditLog.entity_id == entity_id)
    if performed_by is not None:
        conditions.append(AuditLog.performed_by == performed_by)
    if request_id is not None:
        conditions.append(AuditLog.request_id == request_id)
    if created_after is not None:
        conditions.append(AuditLog.created_at >= created_after)
    if created_before is not None:
        conditions.append(AuditLog.created_at <= created_before)

    statement = select(AuditLog).where(*conditions)
    return execute_standard_list(db, statement, params, AUDIT_LOG_LIST_SPEC)
