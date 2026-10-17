import logging
import secrets
from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from pydantic import AwareDatetime, BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user, require_admin
from app.common.listing import DeletedFilter, SortOrder, StandardListRequest
from app.core.config import get_settings
from app.core.database import get_db
from app.core.observability import log_event
from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.scope import effective_levels
from app.systems.access.users.membership import is_platform_operator, require_current_membership
from app.systems.access.users.models import User, UserRole
from app.systems.manage.audit import listeners as _listeners  # noqa: F401
from app.systems.manage.audit.export import encode_audit_csv
from app.systems.manage.audit.labels import target_labels
from app.systems.manage.audit.models import (
    AuditAction,
    AuditLog,
    SecurityEvent,
    SecurityEventOutcome,
)
from app.systems.manage.audit.schemas import (
    AuditLogActorOption,
    AuditLogListResponse,
    AuditLogOptionsResponse,
    AuditLogResponse,
    SecurityEventIngestRequest,
    SecurityEventListResponse,
    SecurityEventResponse,
)
from app.systems.manage.audit.service import (
    AuditLogSortField,
    SecurityEventSortField,
    _security_events_of_bound_organization,
    active_actor_names,
    append_security_event,
    audit_log_statement,
    export_audit_log_rows,
    list_audit_log_options,
    list_audit_logs,
    list_security_events,
)

router = APIRouter(prefix="/audit-logs", tags=["audit"])
security_events_router = APIRouter(prefix="/security-events", tags=["security-events"])
internal_security_events_router = APIRouter(
    prefix="/internal/security-events", tags=["security-events-internal"]
)
AdminUser = Annotated[User, Depends(require_admin)]
CurrentUser = Annotated[User, Depends(get_current_user)]


def _require_audit_list_visibility(
    user: User,
    db: Session,
    department_id: UUID | None,
) -> None:
    if require_current_membership(db, user).role != UserRole.ADMIN.value and (
        department_id is None
        or effective_levels(db, user).department_level(department_id) != AccessLevel.MANAGE
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


def _audit_log_responses(db: Session, user: User, logs: list[AuditLog]) -> list[AuditLogResponse]:
    actor_names = active_actor_names(db, (log.performed_by for log in logs))
    labels = target_labels(db, user, logs)
    responses = []
    for log in logs:
        values = {
            name: getattr(log, name)
            for name in AuditLogResponse.model_fields
            if name not in {"actor_name", "target_label"}
        }
        actor_name = actor_names.get(log.performed_by) if log.performed_by is not None else None
        values.update(actor_name=actor_name, target_label=labels[log.id])
        responses.append(AuditLogResponse.model_validate(values))
    return responses


class AuditLogListRequest(StandardListRequest[AuditLogSortField]):
    sort_order: SortOrder = SortOrder.DESC


class AuditLogExportRequest(BaseModel):
    sort_by: AuditLogSortField | None = None
    sort_order: SortOrder = SortOrder.DESC
    search: str | None = Field(default=None, max_length=100)
    deleted: DeletedFilter = DeletedFilter.EXCLUDE

    @field_validator("search", mode="before")
    @classmethod
    def normalize_search(cls, value: Any) -> Any:
        return StandardListRequest.normalize_search(value)


@router.get("", response_model=AuditLogListResponse)
def get_audit_logs(
    user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[AuditLogListRequest, Depends()],
    action: AuditAction | None = None,
    entity_type: Annotated[str | None, Query(max_length=50)] = None,
    entity_id: UUID | None = None,
    department_id: UUID | None = None,
    performed_by: UUID | None = None,
    request_id: UUID | None = None,
    created_after: datetime | None = None,
    created_before: datetime | None = None,
) -> AuditLogListResponse:
    _require_audit_list_visibility(user, db, department_id)
    result = list_audit_logs(
        db,
        params,
        reader=user,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        department_id=department_id,
        performed_by=performed_by,
        request_id=request_id,
        created_after=created_after,
        created_before=created_before,
    )
    return AuditLogListResponse.model_validate(
        {"items": _audit_log_responses(db, user, result.items), "pagination": result.pagination},
        from_attributes=True,
    )


@router.get("/options", response_model=AuditLogOptionsResponse)
def get_audit_log_options(
    user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
    department_id: UUID | None = None,
    search: Annotated[str | None, Query(max_length=100)] = None,
) -> AuditLogOptionsResponse:
    _require_audit_list_visibility(user, db, department_id)
    entity_types, actor_options = list_audit_log_options(
        db,
        department_id=department_id,
        reader=user,
        search=StandardListRequest.normalize_search(search),
    )
    actor_names = active_actor_names(db, (performed_by for performed_by, _ in actor_options))
    return AuditLogOptionsResponse(
        entity_types=entity_types,
        actors=[
            AuditLogActorOption(
                performed_by=performed_by,
                actor_label=actor_label,
                actor_name=actor_names.get(performed_by),
            )
            for performed_by, actor_label in actor_options
        ],
    )


@router.get(
    "/export",
    response_class=Response,
    responses={
        200: {
            "content": {"text/csv": {"schema": {"type": "string"}}},
            "headers": {"X-Audit-Export-Count": {"schema": {"type": "integer"}}},
        },
        409: {"description": "More than 10,000 filtered audit entries"},
        503: {"description": "Audit export unavailable"},
    },
)
def export_audit_logs(
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[AuditLogExportRequest, Depends()],
    action: AuditAction | None = None,
    entity_type: Annotated[str | None, Query(max_length=50)] = None,
    entity_id: UUID | None = None,
    department_id: UUID | None = None,
    performed_by: UUID | None = None,
    request_id: UUID | None = None,
    created_after: datetime | None = None,
    created_before: datetime | None = None,
) -> Response:
    statement = audit_log_statement(
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        department_id=department_id,
        performed_by=performed_by,
        request_id=request_id,
        created_after=created_after,
        created_before=created_before,
    )
    try:
        rows = export_audit_log_rows(db, statement, AuditLogListRequest(**params.model_dump()))
        content = encode_audit_csv(_audit_log_responses(db, user, rows))
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(503, detail="Audit export unavailable") from None
    return Response(
        content=content,
        media_type="text/csv",
        headers={
            "Content-Disposition": 'attachment; filename="openslate-audit.csv"',
            "Cache-Control": "no-store",
            "X-Audit-Export-Count": str(len(rows)),
        },
    )


@router.get("/{audit_log_id}", response_model=AuditLogResponse)
def get_audit_log(
    audit_log_id: UUID,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> AuditLogResponse:
    log = db.scalar(audit_log_statement().where(AuditLog.id == audit_log_id))
    if log is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audit log not found")
    return _audit_log_responses(db, user, [log])[0]


class SecurityEventListRequest(StandardListRequest[SecurityEventSortField]):
    sort_order: SortOrder = SortOrder.DESC


@security_events_router.get("", response_model=SecurityEventListResponse)
def get_security_events(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[SecurityEventListRequest, Depends()],
    response: Response,
    operation_id: UUID | None = None,
    event_type: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
    outcome: SecurityEventOutcome | None = None,
    person_id: UUID | None = None,
    occurred_after: AwareDatetime | None = None,
    occurred_before: AwareDatetime | None = None,
) -> SecurityEventListResponse:
    if (
        occurred_after is not None
        and occurred_before is not None
        and occurred_after > occurred_before
    ):
        raise HTTPException(422, detail="Security event date range is inverted")
    response.headers["Cache-Control"] = "no-store"
    result = list_security_events(
        db,
        params,
        reader=_,
        operation_id=operation_id,
        event_type=event_type,
        outcome=outcome,
        person_id=person_id,
        occurred_after=occurred_after,
        occurred_before=occurred_before,
    )
    return SecurityEventListResponse.model_validate(
        {"items": result.items, "pagination": result.pagination},
        from_attributes=True,
    )


@security_events_router.get("/export", response_model=list[SecurityEventResponse])
def export_security_events(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
    operation_id: UUID | None = None,
) -> list[SecurityEventResponse]:
    response.headers["Cache-Control"] = "no-store"
    result = list_security_events(
        db,
        SecurityEventListRequest(limit=limit),
        reader=_,
        operation_id=operation_id,
    )
    return [SecurityEventResponse.model_validate(event) for event in result.items[:limit]]


@security_events_router.get("/{security_event_id}", response_model=SecurityEventResponse)
def get_security_event(
    security_event_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> SecurityEventResponse:
    response.headers["Cache-Control"] = "no-store"
    event = db.scalar(select(SecurityEvent).where(
        SecurityEvent.id == security_event_id,
        _security_events_of_bound_organization(operator=is_platform_operator(db, _.id)),
    ))
    if event is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Security event not found",
        )
    return SecurityEventResponse.model_validate(event)


@internal_security_events_router.post(
    "", response_model=SecurityEventResponse, status_code=status.HTTP_201_CREATED
)
def ingest_security_event(
    payload: SecurityEventIngestRequest,
    db: Annotated[Session, Depends(get_db)],
    server_key: Annotated[str | None, Header(alias="X-OpenSlate-Server-Key")] = None,
) -> SecurityEventResponse:
    configured_key = get_settings().security_event_server_key
    expected_key = configured_key.get_secret_value() if configured_key is not None else ""
    provided_key = server_key or ""
    if not expected_key or not secrets.compare_digest(provided_key, expected_key):
        log_event(
            "security_event_ingestion_failed",
            level=logging.WARNING,
            reason_code="ingestion_rejected",
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid server key")

    try:
        event = append_security_event(db, payload)
        db.commit()
    except SQLAlchemyError:
        log_event(
            "security_event_ingestion_failed",
            level=logging.ERROR,
            operation_id=payload.operation_id,
            reason_code="persistence_failed",
        )
        db.rollback()
        raise HTTPException(status_code=503, detail="Security event storage unavailable") from None
    return SecurityEventResponse.model_validate(event)
