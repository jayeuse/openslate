import secrets
from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import Field
from sqlalchemy.orm import Session

from app.common.dependencies import require_roles
from app.common.listing import SortOrder, StandardListRequest
from app.core.config import get_settings
from app.core.database import get_db
from app.systems.audit import listeners as _listeners  # noqa: F401
from app.systems.audit.models import AuditAction, AuditLog, SecurityEvent
from app.systems.audit.schemas import (
    AuditLogListResponse,
    AuditLogResponse,
    SecurityEventIngestRequest,
    SecurityEventListResponse,
    SecurityEventResponse,
)
from app.systems.audit.service import (
    AuditLogSortField,
    SecurityEventSortField,
    append_security_event,
    list_audit_logs,
    list_security_events,
)
from app.systems.users.models import User, UserRole

router = APIRouter(prefix="/audit-logs", tags=["audit"])
security_events_router = APIRouter(prefix="/security-events", tags=["security-events"])
internal_security_events_router = APIRouter(
    prefix="/internal/security-events", tags=["security-events-internal"]
)
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]


class AuditLogListRequest(StandardListRequest[AuditLogSortField]):
    sort_order: SortOrder = SortOrder.DESC


class AuditLogExportRequest(AuditLogListRequest):
    limit: int = Field(default=100, ge=1, le=100)


@router.get("", response_model=AuditLogListResponse)
def get_audit_logs(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[AuditLogListRequest, Depends()],
    action: AuditAction | None = None,
    entity_type: Annotated[str | None, Query(max_length=50)] = None,
    entity_id: UUID | None = None,
    performed_by: UUID | None = None,
    request_id: UUID | None = None,
    created_after: datetime | None = None,
    created_before: datetime | None = None,
) -> AuditLogListResponse:
    result = list_audit_logs(
        db,
        params,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        performed_by=performed_by,
        request_id=request_id,
        created_after=created_after,
        created_before=created_before,
    )
    return AuditLogListResponse.model_validate(
        {"items": result.items, "pagination": result.pagination},
        from_attributes=True,
    )


@router.get("/export", response_model=list[AuditLogResponse])
def export_audit_logs(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[AuditLogExportRequest, Depends()],
    action: AuditAction | None = None,
    entity_type: Annotated[str | None, Query(max_length=50)] = None,
    entity_id: UUID | None = None,
    performed_by: UUID | None = None,
    request_id: UUID | None = None,
    created_after: datetime | None = None,
    created_before: datetime | None = None,
) -> list[AuditLogResponse]:
    result = list_audit_logs(
        db,
        params,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        performed_by=performed_by,
        request_id=request_id,
        created_after=created_after,
        created_before=created_before,
    )
    return [AuditLogResponse.model_validate(log) for log in result.items[: params.limit]]


@router.get("/{audit_log_id}", response_model=AuditLogResponse)
def get_audit_log(
    audit_log_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> AuditLogResponse:
    log = db.get(AuditLog, audit_log_id)
    if log is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audit log not found")
    return AuditLogResponse.model_validate(log)


class SecurityEventListRequest(StandardListRequest[SecurityEventSortField]):
    sort_order: SortOrder = SortOrder.DESC


@security_events_router.get("", response_model=SecurityEventListResponse)
def get_security_events(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[SecurityEventListRequest, Depends()],
    operation_id: UUID | None = None,
) -> SecurityEventListResponse:
    result = list_security_events(db, params, operation_id=operation_id)
    return SecurityEventListResponse.model_validate(
        {"items": result.items, "pagination": result.pagination},
        from_attributes=True,
    )


@security_events_router.get("/export", response_model=list[SecurityEventResponse])
def export_security_events(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
    operation_id: UUID | None = None,
) -> list[SecurityEventResponse]:
    result = list_security_events(
        db,
        SecurityEventListRequest(limit=limit),
        operation_id=operation_id,
    )
    return [SecurityEventResponse.model_validate(event) for event in result.items[:limit]]


@security_events_router.get("/{security_event_id}", response_model=SecurityEventResponse)
def get_security_event(
    security_event_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> SecurityEventResponse:
    event = db.get(SecurityEvent, security_event_id)
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
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid server key")

    event = append_security_event(db, payload)
    db.commit()
    return SecurityEventResponse.model_validate(event)
