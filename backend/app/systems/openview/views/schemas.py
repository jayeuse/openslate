from datetime import datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.records.query_schemas import QueryDefinition


class ViewPresentation(BaseModel):
    """Version-one layout state, kept separate from the query definition."""

    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    layout: Literal["table", "grid", "gallery"] = "table"
    column_field_ids: list[UUID] = Field(default_factory=list, max_length=20)
    pinned_field_ids: list[UUID] = Field(default_factory=list, max_length=1)
    density: Literal["comfortable", "compact"] = "comfortable"
    wrap: bool = False
    card_size: Literal["comfortable", "compact"] = "comfortable"
    primary_field_id: UUID | None = None
    secondary_field_id: UUID | None = None
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
    definition: QueryDefinition
    presentation: ViewPresentation = Field(default_factory=ViewPresentation)
    is_default: StrictBool = False


class ViewUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    revision: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    definition: QueryDefinition | None = None
    presentation: ViewPresentation | None = None
    is_default: StrictBool | None = None

    @model_validator(mode="after")
    def nonempty_update(self) -> Self:
        changed = self.model_fields_set - {"revision"}
        if not changed or any(getattr(self, key) is None for key in changed):
            raise ValueError("At least one non-null change is required")
        return self


class ViewRestore(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)


class ViewResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    module_id: UUID
    name: str
    is_default: bool
    definition: QueryDefinition
    presentation: ViewPresentation
    revision: int
    is_deleted: bool
    can_edit: bool
    created_at: datetime
    updated_at: datetime


class ViewDataSourceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    department_id: UUID
    title_field_id: UUID | None = None


class ViewFieldResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    module_id: UUID
    name: str
    type: FieldType
    required: bool
    position: int
    config: dict[str, object]
