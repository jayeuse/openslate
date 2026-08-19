from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.systems.audit.models import AuditAction


class AuditLogResponse(BaseModel):
    id: UUID
    action: AuditAction
    table_name: str
    record_id: UUID
    snapshot: dict[str, object]
    request_id: UUID | None
    request_method: str | None
    request_path: str | None
    performed_by: str | None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AuditLogListResponse(BaseModel):
    items: list[AuditLogResponse]
    next_cursor: str | None = Field(default=None)
