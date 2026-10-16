import logging
from collections.abc import Iterable
from datetime import datetime
from enum import StrEnum
from typing import Any, cast
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import Select, String, and_, exists, func, or_, select
from sqlalchemy import cast as sql_cast
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, aliased
from sqlalchemy.sql.elements import ColumnElement
from uuid6 import uuid7

from app.common.listing import (
    ListQueryResult,
    ListQuerySpec,
    StandardListRequest,
    build_standard_list_statements,
    execute_standard_list,
)
from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.core.database.session import AuditSession, get_engine
from app.core.middleware.request_context import get_current_request_context
from app.core.observability import log_event
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.membership import bound_membership_join, require_current_membership
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.manage.audit.models import (
    AuditAction,
    AuditLog,
    SecurityEvent,
    SecurityEventOutcome,
)
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.access import readable_link_clause
from app.systems.sandbox.relationships.models import RelationshipEdge


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
        cast(ColumnElement[str], sql_cast(AuditLog.action, String)),
        cast(ColumnElement[str], AuditLog.entity_type),
        cast(ColumnElement[str], AuditLog.request_path),
        cast(ColumnElement[str], AuditLog.actor_label),
        cast(ColumnElement[str], sql_cast(AuditLog.entity_id, String)),
        cast(ColumnElement[str], sql_cast(AuditLog.before, String)),
        cast(ColumnElement[str], sql_cast(AuditLog.after, String)),
    ),
)


AUDIT_EXPORT_LIMIT = 10_000


def _logged_record_id(key: str) -> ColumnElement[Any]:
    snapshot = func.coalesce(AuditLog.after[key].astext, AuditLog.before[key].astext)
    return sql_cast(snapshot, PostgreSQLUUID(as_uuid=True))


def readable_audit_entries(db: Session, reader: User) -> ColumnElement[bool]:
    """Show a link entry only to a reader of both of its modules, as the link API does.

    The link row names its records while it exists. After a purge, the entry's own
    snapshot can still name them. An entry that names neither stays hidden.
    """

    def readable(source: Any, target: Any) -> ColumnElement[bool]:
        return readable_link_clause(db, reader, source.module_id, target.module_id)

    source, target = aliased(Record), aliased(Record)
    through_link = exists(
        select(RelationshipEdge.id)
        .join(source, source.id == RelationshipEdge.source_record_id)
        .join(target, target.id == RelationshipEdge.target_record_id)
        .where(RelationshipEdge.id == AuditLog.entity_id, readable(source, target))
    )
    logged_source, logged_target = aliased(Record), aliased(Record)
    through_snapshot = exists(
        select(logged_source.id)
        .join(logged_target, logged_target.id == _logged_record_id("target_record_id"))
        .where(
            logged_source.id == _logged_record_id("source_record_id"),
            readable(logged_source, logged_target),
        )
    )
    return or_(
        AuditLog.entity_type != RelationshipEdge.__tablename__, through_link, through_snapshot
    )


def _bound_members() -> Select[tuple[UUID]]:
    return select(Membership.user_id).where(Membership.org_id == bound_organization_column())


def _audit_rows_of_bound_organization() -> ColumnElement[bool]:
    """Rows of the bound organization, and account rows of its own people.

    Install-wide rows (platform settings, backups) stay hidden from organization
    readers until the owner decides who reads them (S07 checkpoint).
    """

    return or_(
        AuditLog.org_id == bound_organization_column(),
        and_(
            AuditLog.org_id.is_(None),
            AuditLog.entity_type == User.__tablename__,
            AuditLog.entity_id.in_(_bound_members()),
        ),
    )


def _security_events_of_bound_organization() -> ColumnElement[bool]:
    """Events of the bound organization, and account events about its own people."""

    return or_(
        SecurityEvent.org_id == bound_organization_column(),
        and_(
            SecurityEvent.org_id.is_(None),
            or_(
                SecurityEvent.actor_id.in_(_bound_members()),
                SecurityEvent.subject_id.in_(_bound_members()),
            ),
        ),
    )


def _reader_conditions(db: Session, reader: User | None) -> list[ColumnElement[bool]]:
    organization = _audit_rows_of_bound_organization()
    if reader is None or require_current_membership(db, reader).role == UserRole.ADMIN.value:
        return [organization]
    return [organization, readable_audit_entries(db, reader)]


def audit_log_statement(
    *,
    action: AuditAction | None = None,
    entity_type: str | None = None,
    entity_id: UUID | None = None,
    department_id: UUID | None = None,
    performed_by: UUID | None = None,
    request_id: UUID | None = None,
    created_after: datetime | None = None,
    created_before: datetime | None = None,
) -> Select[tuple[AuditLog]]:
    conditions: list[ColumnElement[bool]] = [_audit_rows_of_bound_organization()]
    if action is not None:
        conditions.append(AuditLog.action == action)
    if entity_type is not None:
        conditions.append(AuditLog.entity_type == entity_type)
    if entity_id is not None:
        conditions.append(AuditLog.entity_id == entity_id)
    if department_id is not None:
        conditions.append(AuditLog.department_id == department_id)
    if performed_by is not None:
        conditions.append(AuditLog.performed_by == performed_by)
    if request_id is not None:
        conditions.append(AuditLog.request_id == request_id)
    if created_after is not None:
        conditions.append(AuditLog.created_at >= created_after)
    if created_before is not None:
        conditions.append(AuditLog.created_at <= created_before)

    return select(AuditLog).where(*conditions)


def list_audit_logs(
    db: Session,
    params: StandardListRequest[AuditLogSortField],
    *,
    reader: User | None = None,
    action: AuditAction | None = None,
    entity_type: str | None = None,
    entity_id: UUID | None = None,
    department_id: UUID | None = None,
    performed_by: UUID | None = None,
    request_id: UUID | None = None,
    created_after: datetime | None = None,
    created_before: datetime | None = None,
) -> ListQueryResult[AuditLog]:
    statement = audit_log_statement(
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        department_id=department_id,
        performed_by=performed_by,
        request_id=request_id,
        created_after=created_after,
        created_before=created_before,
    ).where(*_reader_conditions(db, reader))
    return execute_standard_list(db, statement, params, AUDIT_LOG_LIST_SPEC)


def export_audit_log_rows(
    db: Session,
    statement: Select[tuple[AuditLog]],
    params: StandardListRequest[AuditLogSortField],
) -> list[AuditLog]:
    ordered, _ = build_standard_list_statements(statement, params, AUDIT_LOG_LIST_SPEC)
    rows = list(db.scalars(ordered.offset(None).limit(AUDIT_EXPORT_LIMIT + 1)).all())
    if len(rows) > AUDIT_EXPORT_LIMIT:
        raise HTTPException(
            409,
            detail={
                "code": "audit_export_limit",
                "message": (
                    "Audit exports support up to 10,000 entries. Narrow your filters and try again."
                ),
            },
        )
    return rows


def active_actor_names(db: Session, performed_by_ids: Iterable[UUID | None]) -> dict[UUID, str]:
    actor_ids = {performed_by for performed_by in performed_by_ids if performed_by is not None}
    if not actor_ids:
        return {}
    actors = db.execute(
        select(User.id, User.display_name, User.username)
        .join(Membership, bound_membership_join()).where(
            User.id.in_(actor_ids),
            User.status == UserStatus.ACTIVE.value,
            User.is_deleted.is_(False),
            User.deleted_at.is_(None),
            established_user_clause(),
        )
    ).all()
    return {actor_id: display_name or username for actor_id, display_name, username in actors}


def list_audit_log_options(
    db: Session,
    *,
    department_id: UUID | None = None,
    reader: User | None = None,
    search: str | None = None,
) -> tuple[list[str], list[tuple[UUID, str | None]]]:
    conditions = _reader_conditions(db, reader)
    if department_id is not None:
        conditions.append(AuditLog.department_id == department_id)

    pattern = None
    entity_conditions = [*conditions]
    if search:
        escaped = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        entity_conditions.append(AuditLog.entity_type.ilike(pattern, escape="\\"))

    entity_types = list(
        db.scalars(
            select(AuditLog.entity_type)
            .where(*entity_conditions)
            .group_by(AuditLog.entity_type)
            .order_by(func.max(AuditLog.created_at).desc(), AuditLog.entity_type.asc())
            .limit(200)
        ).all()
    )

    actor_rank = (
        func.row_number()
        .over(
            partition_by=AuditLog.performed_by,
            order_by=(AuditLog.created_at.desc(), AuditLog.id.desc()),
        )
        .label("actor_rank")
    )
    recent_actor_rows = (
        select(
            AuditLog.performed_by,
            AuditLog.actor_label,
            AuditLog.created_at.label("last_used"),
            actor_rank,
        )
        .where(*conditions, AuditLog.performed_by.is_not(None))
        .subquery()
    )
    actor_conditions = [recent_actor_rows.c.actor_rank == 1]
    if pattern is not None:
        current_name_matches = exists(
            select(User.id).join(Membership, bound_membership_join()).where(
                User.id == recent_actor_rows.c.performed_by,
                User.status == UserStatus.ACTIVE.value,
                User.is_deleted.is_(False),
                User.deleted_at.is_(None),
                established_user_clause(),
                or_(
                    User.display_name.ilike(pattern, escape="\\"),
                    User.username.ilike(pattern, escape="\\"),
                ),
            )
        )
        actor_conditions.append(
            or_(
                recent_actor_rows.c.actor_label.ilike(pattern, escape="\\"),
                current_name_matches,
            )
        )
    actor_rows = (
        db.execute(
            select(recent_actor_rows.c.performed_by, recent_actor_rows.c.actor_label)
            .where(*actor_conditions)
            .order_by(
                recent_actor_rows.c.last_used.desc(),
                recent_actor_rows.c.performed_by.asc(),
            )
            .limit(200)
        )
        .tuples()
        .all()
    )
    actors = [
        (performed_by, actor_label)
        for performed_by, actor_label in actor_rows
        if performed_by is not None
    ]
    return entity_types, actors


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
            "security_event_ingestion_failed",
            level=logging.ERROR,
            operation_id=payload.operation_id,
            reason_code="persistence_failed",
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
    event_type: str | None = None,
    outcome: SecurityEventOutcome | None = None,
    person_id: UUID | None = None,
    occurred_after: datetime | None = None,
    occurred_before: datetime | None = None,
) -> ListQueryResult[SecurityEvent]:
    conditions: list[ColumnElement[bool]] = [_security_events_of_bound_organization()]
    if operation_id is not None:
        conditions.append(SecurityEvent.operation_id == operation_id)
    if event_type is not None:
        conditions.append(SecurityEvent.event_type == event_type)
    if outcome is not None:
        conditions.append(SecurityEvent.outcome == outcome)
    if person_id is not None:
        conditions.append(
            or_(SecurityEvent.actor_id == person_id, SecurityEvent.subject_id == person_id)
        )
    if occurred_after is not None:
        conditions.append(SecurityEvent.occurred_at >= occurred_after)
    if occurred_before is not None:
        conditions.append(SecurityEvent.occurred_at < occurred_before)

    statement = select(SecurityEvent).where(*conditions)
    return execute_standard_list(db, statement, params, SECURITY_EVENT_LIST_SPEC)
