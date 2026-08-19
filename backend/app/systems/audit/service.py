import base64
import json
from datetime import datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.systems.audit.models import AuditAction, AuditLog


def encode_cursor(log: AuditLog) -> str:
    payload = {"created_at": log.created_at.isoformat(), "id": str(log.id)}
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    return encoded.rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(f"{cursor}{padding}"))
        return datetime.fromisoformat(payload["created_at"]), UUID(payload["id"])
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Invalid audit log cursor",
        ) from error


def list_audit_logs(
    db: Session,
    *,
    action: AuditAction | None = None,
    entity_type: str | None = None,
    entity_id: UUID | None = None,
    performed_by: UUID | None = None,
    request_id: UUID | None = None,
    created_after: datetime | None = None,
    created_before: datetime | None = None,
    cursor: str | None = None,
    limit: int = 50,
) -> tuple[list[AuditLog], str | None]:
    conditions = []
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
    if cursor is not None:
        cursor_created_at, cursor_id = decode_cursor(cursor)
        conditions.append(
            or_(
                AuditLog.created_at < cursor_created_at,
                and_(AuditLog.created_at == cursor_created_at, AuditLog.id < cursor_id),
            )
        )

    query = (
        select(AuditLog)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .limit(limit + 1)
    )
    if conditions:
        query = query.where(*conditions)
    logs = list(db.scalars(query).all())
    has_next = len(logs) > limit
    items = logs[:limit]
    return items, encode_cursor(items[-1]) if has_next and items else None
