"""HTTP schemas for Board metadata, its groups and its bounded list contract."""

from datetime import datetime
from enum import StrEnum
from typing import Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.common.listing import StandardListRequest, StandardListResponse
from app.systems.access.policy.models import AccessLevel
from app.systems.boards.models import BoardScope, BoardStatus


class BoardSort(StrEnum):
    NAME = "name"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class BoardStatusFilter(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"
    ALL = "all"


class BoardListRequest(StandardListRequest[BoardSort]):
    status: BoardStatusFilter = BoardStatusFilter.ACTIVE
    scope: BoardScope | None = None
    department_id: UUID | None = None


class BoardCreate(BaseModel):
    """A new project Board. Company and department Boards are created by the system."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=200)
    description: str | None = None


class BoardUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    revision: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None

    @model_validator(mode="after")
    def require_change(self) -> Self:
        changed = self.model_fields_set - {"revision"}
        if not changed or ("name" in changed and self.name is None):
            raise ValueError("At least one valid Board field is required")
        return self


class BoardRevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)


class BoardResponse(BaseModel):
    """A Board and the reader's own level on it."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    scope: BoardScope
    department_id: UUID | None
    name: str
    description: str | None
    status: BoardStatus
    revision: int
    level: AccessLevel
    created_at: datetime
    updated_at: datetime


class BoardListResponse(StandardListResponse[BoardResponse]):
    pass


class BoardGroupEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    group_id: UUID
    level: AccessLevel


class BoardGroupsReplace(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)
    groups: list[BoardGroupEntry] = Field(max_length=100)

    @model_validator(mode="after")
    def distinct_groups(self) -> Self:
        if len({entry.group_id for entry in self.groups}) != len(self.groups):
            raise ValueError("Each group can appear once")
        return self


class BoardGroupResponse(BaseModel):
    group_id: UUID
    name: str
    level: AccessLevel


class BoardGroupsResponse(BaseModel):
    board_id: UUID
    revision: int
    groups: list[BoardGroupResponse]
