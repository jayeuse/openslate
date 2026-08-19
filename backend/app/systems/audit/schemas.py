from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from app.common.listing import StandardListResponse
from app.systems.audit.models import AuditAction


class AuditLogResponse(BaseModel):
    id: UUID
    created_at: datetime
    performed_by: UUID | None
    action: AuditAction
    entity_type: str
    entity_id: UUID | None
    before: dict[str, object] | None
    after: dict[str, object] | None
    request_id: UUID | None
    request_method: str | None
    request_path: str | None

    model_config = ConfigDict(from_attributes=True)


class AuditLogListResponse(StandardListResponse[AuditLogResponse]):
    pass
