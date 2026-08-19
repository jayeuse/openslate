from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class RoleCreate(BaseModel):
    role: str = Field(min_length=1, max_length=100)
    permissions: dict[str, Any] = Field(default_factory=dict)


class RoleUpdate(BaseModel):
    role: str | None = Field(default=None, min_length=1, max_length=100)
    permissions: dict[str, Any] | None = None


class RoleResponse(BaseModel):
    id: UUID
    role: str = Field(max_length=100)
    permissions: dict[str, Any]
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class UserResponse(BaseModel):
    id: UUID
    username: str
    role_id: UUID
    role: RoleResponse
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
