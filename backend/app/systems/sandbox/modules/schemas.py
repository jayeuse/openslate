from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ModuleResponse(BaseModel):
    id: UUID
    department_id: UUID
    module_name: str = Field(min_length=1, max_length=150)
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None

    model_config = ConfigDict(from_attributes=True)

    @field_validator("module_name", mode="before")
    @classmethod
    def trim_name(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value
