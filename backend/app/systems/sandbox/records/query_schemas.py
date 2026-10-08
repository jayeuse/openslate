"""Versioned, bounded record query definitions shared by views and exports."""

from datetime import date
from decimal import Decimal
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

from app.common.listing.schemas import DeletedFilter, PaginationMetadata, SortOrder
from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.records.schemas import RecordResponse

Scalar = Annotated[str, Field(max_length=4000)] | StrictBool | StrictInt | StrictFloat
TEXT_LIKE_FIELD_TYPES = {
    FieldType.TEXT,
    FieldType.LONG_TEXT,
    FieldType.EMAIL,
    FieldType.URL,
}
SEARCHABLE_FIELD_TYPES = TEXT_LIKE_FIELD_TYPES | {FieldType.SELECT}


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
        "eq",
        "neq",
        "lt",
        "lte",
        "gt",
        "gte",
        "contains",
        "prefix",
        "suffix",
        "in",
        "empty",
        "not_empty",
        "blank",
        "not_blank",
    ]
    value: Scalar | Annotated[list[Scalar], Field(min_length=1, max_length=100)] | None = None

    @model_validator(mode="after")
    def operator_value(self) -> Self:
        if self.operator in {"empty", "not_empty", "blank", "not_blank"}:
            if self.value is not None:
                raise ValueError("Empty checks do not accept a value")
        elif self.value is None:
            raise ValueError("Comparison requires a value")
        elif (self.operator == "in") != isinstance(self.value, list):
            raise ValueError("Only membership accepts a list")
        allowed = {"eq", "neq", "empty", "not_empty", "blank", "not_blank"}
        if self.expected_type in TEXT_LIKE_FIELD_TYPES:
            allowed |= {"contains", "prefix", "suffix"}
        elif self.expected_type == FieldType.SELECT:
            allowed |= {"contains", "in"}
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
    logic: Literal["and", "or"] = "and"
    sort: list[QuerySort] = Field(default_factory=list, max_length=3)
    search_fields: list[FieldReference] = Field(default_factory=list, max_length=100)
    deleted: DeletedFilter = DeletedFilter.EXCLUDE
    search: str | None = Field(default=None, max_length=240)

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


class ExportRequest(RecordQuery):
    format: Literal["csv", "xlsx"] = "csv"
    view_id: UUID | None = None
    title: str | None = Field(default=None, max_length=120)
    include_details: StrictBool = True
    include_record_id: StrictBool = False
    accent: Literal["theme", "gray", "none"] = "theme"
    banded: StrictBool = False
    totals: StrictBool = False


class WindowRecordQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    module_id: UUID
    definition: QueryDefinition
    mode: Literal["calendar", "timeline"]
    scope: Literal["window", "undated", "unscheduled"]
    date_field: FieldReference | None = None
    start_field: FieldReference | None = None
    end_field: FieldReference | None = None
    from_date: date | None = None
    to_date: date | None = None
    limit: int = Field(default=25, ge=1, le=100)
    offset: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def validate_window_scope(self) -> Self:
        if self.scope == "window":
            if self.from_date is None or self.to_date is None:
                raise ValueError("Window scope requires from_date and to_date")
            if self.to_date < self.from_date:
                raise ValueError("Window end must be on or after its start")
            if (self.to_date - self.from_date).days + 1 > 366:
                raise ValueError("Windows may contain at most 366 days")
        elif self.from_date is not None or self.to_date is not None:
            raise ValueError("Undated and unscheduled scopes do not accept a window")

        date_types = {FieldType.DATE, FieldType.DATETIME}
        if self.mode == "calendar":
            if self.scope not in {"window", "undated"}:
                raise ValueError("Calendar scope must be window or undated")
            if (
                self.date_field is None
                or self.start_field is not None
                or self.end_field is not None
            ):
                raise ValueError("Calendar queries require only date_field")
            if self.date_field.expected_type not in date_types:
                raise ValueError("Calendar fields must be date or datetime")
        else:
            if self.scope not in {"window", "unscheduled"}:
                raise ValueError("Timeline scope must be window or unscheduled")
            if self.date_field is not None or self.start_field is None or self.end_field is None:
                raise ValueError("Timeline queries require start_field and end_field")
            if (
                self.start_field.expected_type not in date_types
                or self.end_field.expected_type not in date_types
            ):
                raise ValueError("Timeline fields must be date or datetime")
        return self


class WindowRecordResponse(BaseModel):
    items: list[RecordResponse]
    pagination: PaginationMetadata
    timezone: str | None


class GroupValueSelector(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["value"]
    value: str


class UnspecifiedGroupSelector(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["unspecified"]


GroupSelector = Annotated[
    GroupValueSelector | UnspecifiedGroupSelector,
    Field(discriminator="kind"),
]


class GroupedRecordQuery(RecordQuery):
    group_by: FieldReference
    group_limit: int = Field(default=100, ge=1, le=100)
    group_offset: int = Field(default=0, ge=0)
    selected_group: GroupSelector | None = None


class RecordGroup(BaseModel):
    value: str | None
    label: str
    count: int


class GroupedRecordResponse(BaseModel):
    items: list[RecordResponse]
    pagination: PaginationMetadata | None
    groups: list[RecordGroup]
    group_pagination: PaginationMetadata
    selected_group: GroupSelector | None


NUMERIC_FIELD_TYPES = {FieldType.NUMBER, FieldType.DECIMAL, FieldType.INTEGER}
MAX_AGGREGATE_SNAPSHOT_BUCKETS = 10_000
MAX_AGGREGATE_SNAPSHOT_BYTES = 8 * 1024 * 1024


class AggregateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    module_id: UUID
    definition: QueryDefinition
    aggregation: Literal["count", "sum", "average"] = "count"
    measure: FieldReference | None = None

    @model_validator(mode="after")
    def validate_measure(self) -> Self:
        if self.aggregation == "count":
            if self.measure is not None:
                raise ValueError("Count does not accept a measure field")
        elif self.measure is None or self.measure.expected_type not in NUMERIC_FIELD_TYPES:
            raise ValueError("Sum and average require a numeric measure field")
        return self


class GroupedAggregateQuery(AggregateRequest):
    mode: Literal["groups"] = "groups"
    dimension: FieldReference
    limit: int = Field(default=12, ge=1, le=100)
    offset: int = Field(default=0, ge=0)


class DateSeriesAggregateQuery(AggregateRequest):
    mode: Literal["date_series"] = "date_series"
    date_field: FieldReference
    from_date: date
    to_date: date

    @model_validator(mode="after")
    def validate_date_window(self) -> Self:
        if self.date_field.expected_type not in {FieldType.DATE, FieldType.DATETIME}:
            raise ValueError("Date series require a date or datetime field")
        days = (self.to_date - self.from_date).days + 1
        if days < 1 or days > 366:
            raise ValueError("Date series windows must contain between 1 and 366 days")
        return self


class GroupedAggregateSnapshotQuery(AggregateRequest):
    mode: Literal["groups"] = "groups"
    dimension: FieldReference
    date_field: FieldReference | None = None
    from_date: date | None = None
    to_date: date | None = None

    @model_validator(mode="after")
    def validate_date_window(self) -> Self:
        if (self.date_field is None) != (self.from_date is None):
            raise ValueError("Grouped date windows require a date field and both bounds")
        if (self.from_date is None) != (self.to_date is None):
            raise ValueError("Grouped date windows require both bounds")
        if self.date_field is None:
            return self
        if self.date_field.expected_type not in {FieldType.DATE, FieldType.DATETIME}:
            raise ValueError("Grouped date windows require a date or datetime field")
        assert self.from_date is not None and self.to_date is not None
        days = (self.to_date - self.from_date).days + 1
        if days < 1 or days > 366:
            raise ValueError("Grouped date windows must contain between 1 and 366 days")
        return self


AggregateSnapshotQuery = Annotated[
    GroupedAggregateSnapshotQuery | DateSeriesAggregateQuery,
    Field(discriminator="mode"),
]


AggregateQuery = Annotated[
    GroupedAggregateQuery | DateSeriesAggregateQuery,
    Field(discriminator="mode"),
]


class AggregateDatum(BaseModel):
    key: str | None
    label: str
    value: int | Decimal
    record_count: int


class AggregatePaginationMetadata(PaginationMetadata):
    limit: int = Field(ge=1, le=366)


class AggregateResponse(BaseModel):
    items: list[AggregateDatum]
    pagination: AggregatePaginationMetadata


class AggregateSnapshotPaginationMetadata(PaginationMetadata):
    limit: int = Field(ge=1, le=MAX_AGGREGATE_SNAPSHOT_BUCKETS)


class AggregateSnapshotResponse(BaseModel):
    items: list[AggregateDatum]
    pagination: AggregateSnapshotPaginationMetadata
