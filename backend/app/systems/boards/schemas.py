"""HTTP schemas for Board metadata and its bounded list contract."""

from datetime import datetime
from enum import StrEnum
from typing import Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.common.listing import StandardListRequest, StandardListResponse
from app.systems.boards.models import BoardSection, BoardStatus


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
    department_id: UUID | None = None


class BoardCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    department_id: UUID | None = None
    default_section: BoardSection = BoardSection.OVERVIEW


class BoardUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    revision: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    department_id: UUID | None = None
    default_section: BoardSection | None = None

    @model_validator(mode="after")
    def require_change(self) -> Self:
        changed = self.model_fields_set - {"revision"}
        if not changed or any(
            getattr(self, field) is None and field in {"name", "default_section"}
            for field in changed
        ):
            raise ValueError("At least one valid Board field is required")
        return self


class BoardRevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)


class BoardResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    owner_id: UUID
    department_id: UUID | None
    name: str
    description: str | None
    status: BoardStatus
    default_section: BoardSection
    revision: int
    created_at: datetime
    updated_at: datetime


class BoardListResponse(StandardListResponse[BoardResponse]):
    pass
