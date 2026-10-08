"""Access group request and response contracts."""

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.common.listing import DeletedFilter, StandardListRequest
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import UserRole, UserStatus


class GroupSortField(StrEnum):
    NAME = "name"
    MEMBER_COUNT = "member_count"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GroupAccessEntry(_StrictModel):
    """One level on a whole department (``module_id`` null) or on one of its modules."""

    department_id: UUID
    module_id: UUID | None = None
    level: AccessLevel


class GroupAccessReplace(_StrictModel):
    access: list[GroupAccessEntry] = Field(max_length=500)


class GroupAccessResponse(GroupAccessEntry):
    department_name: str
    module_name: str | None


class GroupCreate(_StrictModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    member_ids: list[UUID] = Field(default_factory=list, max_length=100)

    @field_validator("name", "description", mode="before")
    @classmethod
    def trim_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class GroupUpdate(_StrictModel):
    """Name and description only; members change through ``PUT .../members``."""

    name: str = Field(default=None, min_length=1, max_length=200)  # type: ignore[assignment]
    description: str = Field(default=None, max_length=2000)  # type: ignore[assignment]

    @field_validator("name", "description", mode="before")
    @classmethod
    def trim_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class GroupMembersReplace(_StrictModel):
    """The complete new member list of one group."""

    member_ids: list[UUID] = Field(max_length=100)


class GroupResponse(BaseModel):
    id: UUID
    name: str
    description: str
    revision: int
    member_ids: list[UUID]
    access: list[GroupAccessResponse]
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None


class GroupListRequest(StandardListRequest[GroupSortField]):
    without_access: bool = False
    without_members: bool = False
    member_id: UUID | None = None


class MemberCandidateSortField(StrEnum):
    USERNAME = "username"
    EMAIL = "email"
    DISPLAY_NAME = "display_name"


class MemberCandidateListRequest(StandardListRequest[MemberCandidateSortField]):
    """Deleted accounts are never candidates."""

    deleted: Literal[DeletedFilter.EXCLUDE] = DeletedFilter.EXCLUDE
    ids: list[UUID] | None = Field(default=None, max_length=100)


class MemberCandidateResponse(BaseModel):
    """The minimum a manager needs to choose a group member."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    display_name: str | None
    username: str
    email: str
    role: UserRole
    status: UserStatus
    access_ends_at: datetime | None = Field(validation_alias="expires_at")
