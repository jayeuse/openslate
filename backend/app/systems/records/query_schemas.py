"""Versioned, bounded record query definitions shared by views and exports."""

from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    model_validator,
)

from app.common.listing.schemas import DeletedFilter, SortOrder
from app.systems.fields.models import FieldType

Scalar = Annotated[str, Field(max_length=4000)] | StrictBool | StrictInt | StrictFloat


class FieldReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    field_id: UUID
    expected_type: FieldType

    @model_validator(mode="after")
    def primitive_only(self) -> Self:
        if self.expected_type == FieldType.RELATIONSHIP:
            raise ValueError("Relationship fields are managed separately")
        return self


class QueryFilter(FieldReference):
    operator: Literal[
        "eq", "lt", "lte", "gt", "gte", "contains", "prefix", "in", "empty", "not_empty"
    ]
    value: Scalar | Annotated[list[Scalar], Field(min_length=1, max_length=100)] | None = None

    @model_validator(mode="after")
    def operator_value(self) -> Self:
        if self.operator in {"empty", "not_empty"}:
            if self.value is not None:
                raise ValueError("Empty checks do not accept a value")
        elif self.value is None:
            raise ValueError("Comparison requires a value")
        elif (self.operator == "in") != isinstance(self.value, list):
            raise ValueError("Only membership accepts a list")
        allowed = {"eq", "empty", "not_empty"}
        if self.expected_type == FieldType.TEXT:
            allowed |= {"contains", "prefix"}
        elif self.expected_type == FieldType.SELECT:
            allowed.add("in")
        elif self.expected_type in {
            FieldType.NUMBER,
            FieldType.DECIMAL,
            FieldType.INTEGER,
            FieldType.DATE,
            FieldType.DATETIME,
        }:
            allowed |= {"lt", "lte", "gt", "gte"}
        if self.operator not in allowed:
            raise ValueError("Operator is unsupported for this field type")
        return self


class QuerySort(FieldReference):
    direction: SortOrder = SortOrder.ASC


class QueryDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    version: Literal[1] = 1
    columns: list[FieldReference] = Field(default_factory=list, max_length=100)
    filters: list[QueryFilter] = Field(default_factory=list, max_length=10)
    sort: list[QuerySort] = Field(default_factory=list, max_length=3)
    deleted: DeletedFilter = DeletedFilter.EXCLUDE
    search: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def unique_columns_and_sort(self) -> Self:
        for references in (self.columns, self.sort):
            if len({ref.field_id for ref in references}) != len(references):
                raise ValueError("Duplicate field references are not permitted")
        if self.search is not None:
            self.search = self.search.strip() or None
        return self


class RecordQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    module_id: UUID
    definition: QueryDefinition
    limit: int = Field(default=25, ge=1, le=100)
    offset: int = Field(default=0, ge=0)
