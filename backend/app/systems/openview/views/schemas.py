from datetime import datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.records.query_schemas import QueryDefinition


class ViewAudience(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["private", "everyone", "user"]
    user_id: UUID | None = None

    @model_validator(mode="after")
    def target_matches_kind(self) -> Self:
        if self.kind in {"private", "everyone"}:
            valid = self.user_id is None
        else:
            valid = self.user_id is not None
        if not valid:
            raise ValueError("Audience target must match its kind")
        return self

    @property
    def visibility(self) -> Literal["private", "workspace"]:
        return "private" if self.kind == "private" else "workspace"


class ViewPresentation(BaseModel):
    """Version-one layout state, kept separate from the query definition."""

    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    layout: Literal["table", "grid", "kanban", "calendar", "timeline", "gallery"] = "table"
    column_field_ids: list[UUID] = Field(default_factory=list, max_length=20)
    pinned_field_ids: list[UUID] = Field(default_factory=list, max_length=1)
    density: Literal["comfortable", "compact"] = "comfortable"
    wrap: bool = False
    card_size: Literal["comfortable", "compact"] = "comfortable"
    primary_field_id: UUID | None = None
    secondary_field_id: UUID | None = None
    date_field_id: UUID | None = None
    timeline_start_field_id: UUID | None = None
    timeline_end_field_id: UUID | None = None
    timeline_deadline_field_id: UUID | None = None
    timeline_progress_field_id: UUID | None = None
    date_range: Literal["week", "month", "quarter", "year"] = "month"
    scale: Literal["month", "list"] | None = None
    group_by_field_id: UUID | None = None

    @model_validator(mode="after")
    def unique_column_references(self) -> Self:
        if len(set(self.column_field_ids)) != len(self.column_field_ids):
            raise ValueError("Duplicate presentation columns are not permitted")
        if len(set(self.pinned_field_ids)) != len(self.pinned_field_ids):
            raise ValueError("Duplicate pinned columns are not permitted")
        if not set(self.pinned_field_ids).issubset(self.column_field_ids):
            raise ValueError("Pinned columns must also be visible columns")
        return self


class ViewCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    module_id: UUID
    name: str = Field(min_length=1, max_length=200)
    audience: ViewAudience | None = None
    visibility: Literal["private", "workspace"] | None = None
    definition: QueryDefinition
    presentation: ViewPresentation = Field(default_factory=ViewPresentation)

    @model_validator(mode="after")
    def resolve_legacy_visibility(self) -> Self:
        audience = self.audience
        if audience is None:
            default_kind = "everyone" if self.visibility == "workspace" else "private"
            audience = ViewAudience(kind=default_kind)
            self.audience = audience
        if self.visibility is not None and self.visibility != audience.visibility:
            raise ValueError("Visibility must agree with audience")
        return self


class ViewUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    revision: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    definition: QueryDefinition | None = None
    presentation: ViewPresentation | None = None
    audience: ViewAudience | None = None
    visibility: Literal["private", "workspace"] | None = None

    @model_validator(mode="after")
    def nonempty_update(self) -> Self:
        changed = self.model_fields_set - {"revision"}
        if not changed or any(getattr(self, key) is None for key in changed):
            raise ValueError("At least one non-null change is required")
        if self.audience is not None and self.visibility is not None:
            if self.audience.visibility != self.visibility:
                raise ValueError("Visibility must agree with audience")
        return self


class ViewRestore(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)


class ViewDefaultSet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    view_id: UUID


class ViewResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    module_id: UUID
    owner_id: UUID
    name: str
    visibility: Literal["private", "workspace"]
    audience: ViewAudience
    definition: QueryDefinition
    presentation: ViewPresentation
    revision: int
    is_deleted: bool
    can_edit: bool
    created_at: datetime
    updated_at: datetime


class ViewDefaultResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    module_id: UUID
    view_id: UUID
    revision: int


class ViewDataSourceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    department_id: UUID


class ViewFieldResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    module_id: UUID
    name: str
    type: FieldType
    required: bool
    position: int
    config: dict[str, object]


class ViewAudienceOptionResponse(BaseModel):
    kind: Literal["user"]
    id: UUID
    label: str
