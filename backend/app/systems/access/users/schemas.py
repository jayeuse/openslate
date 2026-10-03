from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.common.normalization import normalize_email, normalize_username
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import UserRole, UserStatus


class UserResponse(BaseModel):
    id: UUID
    email: str
    username: str
    status: UserStatus
    role: UserRole
    display_name: str | None
    job_title: str | None
    sponsor_user_id: UUID | None
    expires_at: datetime | None
    invitation_sent_at: datetime | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None

    model_config = ConfigDict(from_attributes=True)


class AccessEntryResponse(BaseModel):
    """The user's effective level on a department (``module_id`` null) or on one module.

    A module entry overrides its department entry. A module with neither is hidden.
    """

    department_id: UUID
    module_id: UUID | None
    level: AccessLevel


class AuthMeResponse(UserResponse):
    access: list[AccessEntryResponse]


class UserPreferencesResponse(BaseModel):
    user_id: UUID
    theme: Literal["light", "dark"]


class UserPreferencesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    theme: Literal["light", "dark"]


class AccessGroupResponse(BaseModel):
    """A group whose own row gives an entry its level; a guest's row can be higher."""

    group_id: UUID
    name: str
    level: AccessLevel


class UserAccessEntryResponse(AccessEntryResponse):
    groups: list[AccessGroupResponse]


class UserAccessResponse(BaseModel):
    """A person's effective access. An active administrator is unrestricted with no entries."""

    user_id: UUID
    role: UserRole
    unrestricted: bool
    entries: list[UserAccessEntryResponse]


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=3, max_length=320)
    username: str = Field(min_length=3, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    role: UserRole = UserRole.MEMBER
    group_ids: list[UUID] = Field(default_factory=list, max_length=100)
    display_name: str | None = Field(default=None, max_length=200)
    job_title: str | None = Field(default=None, max_length=200)
    sponsor_user_id: UUID | None = None
    expires_at: datetime | None = None

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: Any) -> Any:
        return normalize_email(value)

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username(cls, value: Any) -> Any:
        return normalize_username(value)


class InvitationCreate(UserCreate):
    """Administrator-selected profile and authorization for a provider email invite."""


class InvitationResponse(BaseModel):
    user: UserResponse
    delivery: Literal["email"] = "email"


class InvitationResendRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str | None = Field(
        default=None,
        min_length=3,
        max_length=100,
        pattern=r"^[a-zA-Z0-9_-]+$",
    )
    role: Literal[UserRole.ADMIN, UserRole.MEMBER] | None = None
    status: Literal[UserStatus.ACTIVE, UserStatus.DISABLED] | None = None
    display_name: str | None = Field(default=None, max_length=200)
    job_title: str | None = Field(default=None, max_length=200)
    sponsor_user_id: UUID | None = None
    expires_at: datetime | None = None

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username(cls, value: Any) -> Any:
        return normalize_username(value)
