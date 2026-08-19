from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ModuleCreate(BaseModel):
    department_id: UUID
    module_name: str = Field(min_length=1, max_length=150)


class ModuleUpdate(BaseModel):
    department_id: UUID | None = None
    module_name: str | None = Field(default=None, min_length=1, max_length=150)


class ModuleResponse(ModuleCreate):
    id: UUID
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
