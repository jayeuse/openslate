"""The frozen structure request shapes and standard offset-list bindings."""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, field_validator, model_validator

from app.common.listing import SortOrder, StandardListRequest
from app.systems.comms.messages.schemas import Watermark, WireModel


class ResourceSort(StrEnum):
    POSITION = "position"
    NAME = "name"
    UPDATED = "updated_at"


class MemberSort(StrEnum):
    NAME = "display_name"


class TimeSort(StrEnum):
    CREATED = "created_at"
    UPDATED = "updated_at"


class CategoryQuery(WireModel):
    limit: int = Field(25, ge=1, le=100)
    offset: int = Field(0, ge=0)
    sort_order: SortOrder = SortOrder.ASC
    sort_by: ResourceSort = ResourceSort.POSITION
    search: str | None = Field(None, max_length=100)

    def standard(self) -> StandardListRequest[ResourceSort]:
        return StandardListRequest[ResourceSort](**self.model_dump(exclude={"archived"}))


class ConversationQuery(CategoryQuery):
    archived: bool = False


class MemberQuery(WireModel):
    limit: int = Field(25, ge=1, le=100)
    offset: int = Field(0, ge=0)
    sort_order: SortOrder = SortOrder.ASC
    sort_by: MemberSort = MemberSort.NAME
    search: str | None = Field(None, max_length=100)


class BlockQuery(WireModel):
    limit: int = Field(25, ge=1, le=100)
    offset: int = Field(0, ge=0)
    sort_order: SortOrder = SortOrder.ASC
    sort_by: TimeSort = TimeSort.CREATED


class NamedRequest(WireModel):
    name: str = Field(min_length=1, strict=True)

    @field_validator("name", mode="before")
    @classmethod
    def normalize_name(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class CategoryRequest(NamedRequest):
    position: Watermark = Field(strict=True)
    department_id: UUID | None


class ChannelBase(NamedRequest):
    topic: str = Field(strict=True)
    category_id: UUID | None
    position: Watermark = Field(strict=True)


class OrganizationChannelRequest(ChannelBase):
    scope: Literal["organization"]


class DepartmentChannelRequest(ChannelBase):
    scope: Literal["department"]
    department_id: UUID


# D44: a channel is organization-wide or one department's; hand-picked people use a group.
ChannelRequest = Annotated[
    OrganizationChannelRequest | DepartmentChannelRequest,
    Field(discriminator="scope"),
]


class ChannelPatch(WireModel):
    name: str | None = Field(None, min_length=1, strict=True)
    topic: str | None = Field(None, strict=True)
    category_id: UUID | None = None
    position: Watermark | None = Field(None, strict=True)

    @field_validator("name", mode="before")
    @classmethod
    def normalize_name(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def nonnullable_fields(self) -> "ChannelPatch":
        if any(getattr(self, key) is None for key in self.model_fields_set - {"category_id"}):
            raise ValueError("Channel fields cannot be null")
        return self


class DirectRequest(WireModel):
    recipient_id: UUID


class GroupRequest(WireModel):
    name: str = Field("", strict=True)
    participant_ids: list[UUID] = Field(min_length=3, max_length=50)

    @field_validator("participant_ids")
    @classmethod
    def distinct_people(cls, ids: list[UUID]) -> list[UUID]:
        if len(ids) != len(set(ids)):
            raise ValueError("Participants must be distinct")
        return ids


class MemberRoleRequest(WireModel):
    role: Literal["member", "manager"]


class DuplicateRequest(NamedRequest):
    category_id: UUID | None


class BlockRequest(WireModel):
    blocked_user_id: UUID


class DirectBlockResponse(WireModel):
    blocked_user_id: UUID
    created_at: datetime


class MemberDepartment(WireModel):
    id: UUID
    name: str


class MemberResponse(WireModel):
    user_id: UUID
    display_name: str
    member_role: Literal["member", "manager"]
    level: Literal["read", "post", "manage"]
    joined_at: datetime
    departments: list[MemberDepartment]
