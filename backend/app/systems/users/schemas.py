from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.common.normalization import normalize_email, normalize_username
from app.systems.users.models import UserStatus


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
    email: str
    username: str
    status: UserStatus
    role_id: UUID
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None

    model_config = ConfigDict(from_attributes=True)


class UserCreate(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    username: str = Field(min_length=3, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    role_id: UUID | None = None

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: Any) -> Any:
        return normalize_email(value)

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username(cls, value: Any) -> Any:
        return normalize_username(value)


class UserUpdate(BaseModel):
    username: str | None = Field(
        default=None,
        min_length=3,
        max_length=100,
        pattern=r"^[a-zA-Z0-9_-]+$",
    )
    role_id: UUID | None = None
    status: UserStatus | None = None

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username(cls, value: Any) -> Any:
        return normalize_username(value)
