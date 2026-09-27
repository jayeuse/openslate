"""Access group request and response contracts."""

from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.common.listing import StandardListRequest
from app.systems.access.policy.models import AccessLevel


class GroupSortField(StrEnum):
    NAME = "name"
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


class GroupCreate(_StrictModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    member_ids: list[UUID] = Field(default_factory=list, max_length=100)

    @field_validator("name", "description", mode="before")
    @classmethod
    def trim_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class GroupUpdate(_StrictModel):
    name: str = Field(default=None, min_length=1, max_length=200)  # type: ignore[assignment]
    description: str = Field(default=None, max_length=2000)  # type: ignore[assignment]
    member_ids: list[UUID] = Field(default=None, max_length=100)  # type: ignore[arg-type]

    @field_validator("name", "description", mode="before")
    @classmethod
    def trim_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class GroupResponse(BaseModel):
    id: UUID
    name: str
    description: str
    revision: int
    member_ids: list[UUID]
    access: list[GroupAccessEntry]
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None


class GroupListRequest(StandardListRequest[GroupSortField]):
    pass
