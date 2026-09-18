from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field, field_validator


class SortOrder(StrEnum):
    ASC = "asc"
    DESC = "desc"


class DeletedFilter(StrEnum):
    EXCLUDE = "exclude"
    INCLUDE = "include"
    ONLY = "only"


class StandardListRequest[SortFieldT: StrEnum](BaseModel):
    limit: int = Field(default=25, ge=1, le=100)
    offset: int = Field(default=0, ge=0)
    sort_by: SortFieldT | None = None
    sort_order: SortOrder = SortOrder.ASC
    search: str | None = Field(default=None, max_length=100)
    deleted: DeletedFilter = DeletedFilter.EXCLUDE

    @field_validator("search", mode="before")
    @classmethod
    def normalize_search(cls, value: Any) -> Any:
        if isinstance(value, str):
            normalized = value.strip()
            return normalized or None
        return value


class PaginationMetadata(BaseModel):
    limit: int = Field(ge=1, le=100)
    offset: int = Field(ge=0)
    count: int = Field(ge=0)
    total: int = Field(ge=0)
    has_more: bool


class StandardListResponse[ResponseItemT](BaseModel):
    items: list[ResponseItemT]
    pagination: PaginationMetadata
