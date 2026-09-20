from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.common.normalization import normalize_email, normalize_username
from app.systems.access.users.models import UserStatus
from app.systems.access.users.permissions import validate_permissions


class RoleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: str = Field(min_length=1, max_length=100)
    permissions: dict[str, Any] = Field(default_factory=dict)

    @field_validator("role", mode="before")
    @classmethod
    def trim_role(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("permissions")
    @classmethod
    def validate_permission_document(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_permissions(value)


class RoleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: str | None = Field(default=None, min_length=1, max_length=100)
    permissions: dict[str, Any] | None = None

    @field_validator("role", mode="before")
    @classmethod
    def trim_role(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("permissions")
    @classmethod
    def validate_permission_document(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_permissions(value)


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


class AuthMeResponse(UserResponse):
    role: str
    permissions: list[str]


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

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


class InvitationCreate(UserCreate):
    """Local invitation delivery request."""

    delivery: Literal["temporary_password", "email"] = "temporary_password"
    temporary_password: str | None = Field(default=None, min_length=12, max_length=128)

    @field_validator("temporary_password")
    @classmethod
    def require_temporary_password_for_temporary_delivery(cls, value: str | None) -> str | None:
        return value


class InvitationResponse(BaseModel):
    user: UserResponse
    delivery: Literal["temporary_password", "email"]
    temporary_password: str | None = None


class InvitationResendRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    delivery: Literal["temporary_password", "email"] = "temporary_password"
    temporary_password: str | None = Field(default=None, min_length=12, max_length=128)


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str | None = Field(
        default=None,
        min_length=3,
        max_length=100,
        pattern=r"^[a-zA-Z0-9_-]+$",
    )
    role_id: UUID | None = None
    status: Literal[UserStatus.ACTIVE, UserStatus.DISABLED] | None = None

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username(cls, value: Any) -> Any:
        return normalize_username(value)
