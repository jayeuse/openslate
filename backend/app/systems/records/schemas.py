from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class RecordCreate(BaseModel):
    module_id: UUID
    data: dict[str, Any] = Field(default_factory=dict)


class RecordUpdate(BaseModel):
    module_id: UUID | None = None
    data: dict[str, Any] | None = None



class RecordResponse(RecordCreate):
    id: UUID
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None

    model_config = ConfigDict(from_attributes=True)
