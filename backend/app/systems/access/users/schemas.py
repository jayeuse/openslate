from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.common.normalization import normalize_email, normalize_username
from app.systems.access.users.models import IdentityKind, UserStatus
from app.systems.access.users.permissions import validate_permissions


class RoleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=1000)
    permissions: dict[str, Any] = Field(default_factory=dict)

    @field_validator("role", mode="before")
    @classmethod
    def trim_role(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("description", mode="before")
    @classmethod
    def normalize_description(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        return value.strip() or None

    @field_validator("permissions")
    @classmethod
    def validate_permission_document(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_permissions(value)


class RoleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=1000)
    permissions: dict[str, Any] | None = None

    @field_validator("role", mode="before")
    @classmethod
    def trim_role(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("description", mode="before")
    @classmethod
    def normalize_description(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        return value.strip() or None

    @field_validator("permissions")
    @classmethod
    def validate_permission_document(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return value
        return validate_permissions(value)


class RoleResponse(BaseModel):
    id: UUID
    role: str = Field(max_length=100)
    description: str | None
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
    display_name: str | None
    identity_kind: IdentityKind
    job_title: str | None
    sponsor_user_id: UUID | None
    expires_at: datetime | None
    invitation_sent_at: datetime | None
    department_ids: list[UUID]
    primary_department_id: UUID | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None

    model_config = ConfigDict(from_attributes=True)

    @model_validator(mode="before")
    @classmethod
    def include_department_summary(cls, value: Any) -> Any:
        if isinstance(value, dict):
            return value
        memberships = sorted(
            getattr(value, "department_memberships", ()),
            key=lambda membership: str(membership.department_id),
        )
        response = {
            field: getattr(value, field)
            for field in cls.model_fields
            if field not in {"department_ids", "primary_department_id"}
        }
        response["identity_kind"] = response["identity_kind"] or IdentityKind.INTERNAL
        response["department_ids"] = [membership.department_id for membership in memberships]
        response["primary_department_id"] = next(
            (membership.department_id for membership in memberships if membership.is_primary),
            None,
        )
        return response


class AuthMeResponse(UserResponse):
    role: str
    permissions: list[str]


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=3, max_length=320)
    username: str = Field(min_length=3, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    role_id: UUID | None = None
    display_name: str | None = Field(default=None, max_length=200)
    identity_kind: IdentityKind = IdentityKind.INTERNAL
    job_title: str | None = Field(default=None, max_length=200)
    sponsor_user_id: UUID | None = None
    expires_at: datetime | None = None
    department_ids: list[UUID] | None = Field(default=None, max_length=100)
    primary_department_id: UUID | None = None

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
    display_name: str | None = Field(default=None, max_length=200)
    job_title: str | None = Field(default=None, max_length=200)
    sponsor_user_id: UUID | None = None
    expires_at: datetime | None = None
    department_ids: list[UUID] | None = Field(default=None, max_length=100)
    primary_department_id: UUID | None = None

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username(cls, value: Any) -> Any:
        return normalize_username(value)
