from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class FieldCreate(BaseModel):
    module_id: UUID
    name: str = Field(min_length=1, max_length=150)
    type: str = Field(min_length=1, max_length=20)
    required: bool = False
    position: int = Field(ge=0)
    config: dict[str, Any] = Field(default_factory=dict)


class FieldUpdate(BaseModel):
    module_id: UUID | None = None
    name: str | None = Field(default=None, min_length=1, max_length=150)
    type: str | None = Field(default=None, min_length=1, max_length=20)
    required: bool | None = None
    position: int | None = Field(default=None, ge=0)
    config: dict[str, Any] | None = None


class FieldResponse(FieldCreate):
    id: UUID
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
