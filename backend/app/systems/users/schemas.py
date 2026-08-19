from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class RoleCreate(BaseModel):
    role: str = Field(min_length=1, max_length=100)
    permissions: dict[str, Any] = Field(default_factory=dict)

    @field_validator("role", mode="before")
    @classmethod
    def trim_role(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class RoleUpdate(BaseModel):
    role: str | None = Field(default=None, min_length=1, max_length=100)
    permissions: dict[str, Any] | None = None

    @field_validator("role", mode="before")
    @classmethod
    def trim_role(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value



class RoleResponse(BaseModel):
    id: UUID
    role: str = Field(max_length=100)
    permissions: dict[str, Any]
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None

    model_config = ConfigDict(from_attributes=True)


class UserResponse(BaseModel):
    id: UUID
    username: str
    role_id: UUID
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None

    model_config = ConfigDict(from_attributes=True)


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    password: str = Field(min_length=12, max_length=128)
    role_id: UUID

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        return value.lower()


class UserUpdate(BaseModel):
    username: str | None = Field(
        default=None,
        min_length=3,
        max_length=100,
        pattern=r"^[a-zA-Z0-9_-]+$",
    )
    password: str | None = Field(default=None, min_length=12, max_length=128)
    role_id: UUID | None = None

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str | None) -> str | None:
        return value.lower() if value is not None else None
