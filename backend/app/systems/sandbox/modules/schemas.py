from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ModuleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    department_id: UUID
    module_name: str = Field(min_length=1, max_length=150)

    @field_validator("module_name", mode="before")
    @classmethod
    def trim_name(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class ModuleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    department_id: UUID | None = None
    module_name: str | None = Field(default=None, min_length=1, max_length=150)

    @field_validator("module_name", mode="before")
    @classmethod
    def trim_name(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value



class ModuleResponse(ModuleCreate):
    id: UUID
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None
    is_schema_accepted: bool = Field(default=False, json_schema_extra={"readOnly": True})

    model_config = ConfigDict(from_attributes=True)
