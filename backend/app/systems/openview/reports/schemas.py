"""Report metadata and version-one recipe contracts."""

from datetime import datetime
from enum import StrEnum
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from app.common.listing.schemas import SortOrder, StandardListRequest
from app.systems.sandbox.records.query_schemas import (
    FieldReference,
    QueryFilter,
    QuerySort,
)


class ReportRecipe(BaseModel):
    """A bounded, versioned row report definition without delivery policy."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    version: Literal[1] = 1
    fields: list[FieldReference] = Field(min_length=1, max_length=100)
    filters: list[QueryFilter] = Field(default_factory=list, max_length=10)
    logic: Literal["and", "or"] = "and"
    sorts: list[QuerySort] = Field(default_factory=list, max_length=3)
    group_by: FieldReference | None = None
    include_row_count: StrictBool = False

    @model_validator(mode="after")
    def field_references_are_unique(self) -> Self:
        for references in (self.fields, self.sorts):
            if len({reference.field_id for reference in references}) != len(references):
                raise ValueError("Duplicate report field references are not permitted")
        return self


class ReportCreate(BaseModel):
    """Creation input; the Report belongs to the department of its module."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    module_id: UUID
    name: str = Field(min_length=1, max_length=80)
    subtitle: str | None = Field(default=None, max_length=160)
    recipe: ReportRecipe


class ReportUpdate(BaseModel):
    """Revision-preconditioned partial update of a Report."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    revision: int = Field(ge=1)
    module_id: UUID | None = None
    name: str | None = Field(default=None, min_length=1, max_length=80)
    subtitle: str | None = Field(default=None, max_length=160)
    recipe: ReportRecipe | None = None

    @model_validator(mode="after")
    def require_nonempty_update(self) -> Self:
        changed = self.model_fields_set - {"revision"}
        if not changed or any(
            getattr(self, field_name) is None for field_name in changed - {"subtitle"}
        ):
            raise ValueError("At least one non-null Report change is required")
        return self


class ReportRevisionRequest(BaseModel):
    """Revision precondition for restoring an archived Report."""

    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)


class ReportSort(StrEnum):
    NAME = "name"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class ReportListRequest(StandardListRequest[ReportSort]):
    """Bounded Report listing with an optional source module."""

    module_id: UUID | None = None


class ReportResponse(BaseModel):
    """Persisted recipe metadata, never a generated output snapshot."""

    model_config = ConfigDict(extra="forbid")

    id: UUID
    module_id: UUID
    name: str
    subtitle: str | None
    revision: int = Field(ge=1)
    recipe: ReportRecipe
    is_deleted: bool
    created_at: datetime
    updated_at: datetime


class ReportRunResponse(BaseModel):
    """Metadata for one immutable, successful Report output snapshot."""

    model_config = ConfigDict(extra="forbid")

    id: UUID
    report_id: UUID
    recipe_revision: int = Field(ge=1)
    row_count: int = Field(ge=0)
    headings: list[str] = Field(min_length=1, max_length=100)
    created_at: datetime


class ReportRunSort(StrEnum):
    CREATED_AT = "created_at"


class ReportRunListRequest(StandardListRequest[ReportRunSort]):
    """Newest-first metadata pages; archived runs are never listed."""

    sort_order: Literal[SortOrder.DESC] = SortOrder.DESC
