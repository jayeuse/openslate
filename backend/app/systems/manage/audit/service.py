import logging
from datetime import datetime
from enum import StrEnum
from typing import Any, cast
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement
from uuid6 import uuid7

from app.common.listing import (
    ListQueryResult,
    ListQuerySpec,
    StandardListRequest,
    execute_standard_list,
)
from app.core.base_model import utc_now
from app.core.database.session import AuditSession, get_engine
from app.core.middleware.request_context import get_current_request_context
from app.core.observability import log_event
from app.systems.manage.audit.models import AuditAction, AuditLog, SecurityEvent
from app.systems.manage.audit.schemas import SecurityEventIngestRequest


class AuditLogSortField(StrEnum):
    ACTION = "action"
    CREATED_AT = "created_at"
    ENTITY_TYPE = "entity_type"
    REQUEST_PATH = "request_path"


class SecurityEventPersistenceError(RuntimeError):
    """A security event could not be committed durably."""


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


class SecurityEventSortField(StrEnum):
    EVENT_TYPE = "event_type"
    OCCURRED_AT = "occurred_at"
    OUTCOME = "outcome"
    SOURCE = "source"


SECURITY_EVENT_LIST_SPEC = ListQuerySpec(
    sort_fields={
        SecurityEventSortField.EVENT_TYPE: cast(ColumnElement[Any], SecurityEvent.event_type),
        SecurityEventSortField.OCCURRED_AT: cast(ColumnElement[Any], SecurityEvent.occurred_at),
        SecurityEventSortField.OUTCOME: cast(ColumnElement[Any], SecurityEvent.outcome),
        SecurityEventSortField.SOURCE: cast(ColumnElement[Any], SecurityEvent.source),
    },
    default_sort=SecurityEventSortField.OCCURRED_AT,
    tie_breaker=cast(ColumnElement[Any], SecurityEvent.id),
    search_fields=(
        cast(ColumnElement[str], SecurityEvent.event_type),
        cast(ColumnElement[str], SecurityEvent.source),
        cast(ColumnElement[str], SecurityEvent.reason),
        cast(ColumnElement[str], SecurityEvent.request_path),
    ),
)


def append_security_event(db: Session, payload: SecurityEventIngestRequest) -> SecurityEvent:
    context = get_current_request_context()
    event = SecurityEvent(
        id=uuid7(),
        occurred_at=payload.occurred_at or utc_now(),
        event_type=payload.event_type,
        outcome=payload.outcome,
        source=payload.source,
        operation_id=payload.operation_id,
        actor_id=payload.actor_id,
        subject_id=payload.subject_id,
        labels=dict(payload.labels),
        fingerprint=payload.fingerprint,
        reason=payload.reason,
        request_id=payload.request_id or (context.request_id if context else None),
        request_method=payload.request_method or (context.method if context else None),
        request_path=payload.request_path or (context.path if context else None),
        event_metadata=dict(payload.metadata),
    )
    object.__setattr__(event, "_security_event_internal", True)
    db.add(event)
    return event


def append_committed_security_event(payload: SecurityEventIngestRequest) -> None:
    """Commit one security event through a session independent of the request transaction."""

    session = AuditSession(bind=get_engine())
    try:
        append_security_event(session, payload)
        session.commit()
    except SQLAlchemyError as error:
        log_event(
            "security_event_ingestion_failed", level=logging.ERROR,
            operation_id=payload.operation_id, reason_code="persistence_failed",
        )
        session.rollback()
        raise SecurityEventPersistenceError("Unable to commit security event") from error
    finally:
        session.close()


def list_security_events(
    db: Session,
    params: StandardListRequest[SecurityEventSortField],
    *,
    operation_id: UUID | None = None,
) -> ListQueryResult[SecurityEvent]:
    conditions: list[ColumnElement[bool]] = []
    if operation_id is not None:
        conditions.append(SecurityEvent.operation_id == operation_id)

    statement = select(SecurityEvent).where(*conditions)
    return execute_standard_list(db, statement, params, SECURITY_EVENT_LIST_SPEC)
