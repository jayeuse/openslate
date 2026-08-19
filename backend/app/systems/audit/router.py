from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.common.dependencies import require_roles
from app.core.database import get_db
from app.systems.audit import listeners as _listeners  # noqa: F401
from app.systems.audit.models import AuditAction, AuditLog
from app.systems.audit.schemas import AuditLogListResponse, AuditLogResponse
from app.systems.audit.service import list_audit_logs
from app.systems.users.models import User, UserRole

router = APIRouter(prefix="/audit-logs", tags=["audit"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]


@router.get("", response_model=AuditLogListResponse)
def get_audit_logs(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    action: AuditAction | None = None,
    entity_type: Annotated[str | None, Query(max_length=50)] = None,
    entity_id: UUID | None = None,
    performed_by: UUID | None = None,
    request_id: UUID | None = None,
    created_after: datetime | None = None,
    created_before: datetime | None = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> AuditLogListResponse:
    items, next_cursor = list_audit_logs(
        db,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        performed_by=performed_by,
        request_id=request_id,
        created_after=created_after,
        created_before=created_before,
        cursor=cursor,
        limit=limit,
    )
    return AuditLogListResponse(items=items, next_cursor=next_cursor)


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
