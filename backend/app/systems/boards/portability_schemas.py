"""Versioned, structure-only Board configuration for trusted server-side resolution.

Version 3 carries the Board name, description and tiles. Scope and access are not
portable: an import always creates a project Board without groups.
"""

from datetime import date
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.records.aggregate_buckets import AggregateBucket, validate_bucket_window
from app.systems.sandbox.records.query_schemas import (
    AggregateRequest,
    FieldReference,
    GroupedAggregateSnapshotQuery,
    QueryDefinition,
    QueryFilter,
    Scalar,
)


class PortableFieldReference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=150)
    expected_type: FieldType

    @model_validator(mode="after")
    def primitive_named_field(self) -> Self:
        if not self.name.strip() or self.expected_type == FieldType.RELATIONSHIP:
            raise ValueError("A named primitive field is required")
        return self


class PortableQueryFilter(PortableFieldReference):
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
    def matching_operator_and_value(self) -> Self:
        # Reuse the live query grammar; the placeholder never enters the bundle.
        QueryFilter(
            field_id=UUID(int=0),
            expected_type=self.expected_type,
            operator=self.operator,
            value=self.value,
        )
        return self


class PortableWidgetSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    department_name: str = Field(min_length=1, max_length=150)
    module_name: str = Field(min_length=1, max_length=150)

    @model_validator(mode="after")
    def named_source(self) -> Self:
        if not self.department_name.strip() or not self.module_name.strip():
            raise ValueError("A named department and module are required")
        return self


class PortableWidgetConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    fields: list[PortableFieldReference] = Field(max_length=24)
    filters: list[PortableQueryFilter] = Field(max_length=8)
    logic: Literal["and", "or"]
    aggregation: Literal["count", "sum", "average", "min", "max", "distinct"] = "count"
    metric: PortableFieldReference | None
    visualization: Literal["bar", "line", "pie"]
    size: Literal["S", "M", "L", "half", "full"]
    refresh: Literal["manual", "one-minute", "five-minutes"]
    pinned: StrictBool

    @model_validator(mode="after")
    def distinct_fields_and_valid_metric(self) -> Self:
        if len({field.name for field in self.fields}) != len(self.fields):
            raise ValueError("Widget fields must be distinct")
        if "aggregation" not in self.model_fields_set:
            self.aggregation = "sum" if self.metric is not None else "count"
        AggregateRequest(
            module_id=UUID(int=0),
            definition=QueryDefinition(),
            aggregation=self.aggregation,
            measure=_placeholder(self.metric),
        )
        return self


class PortableQuerySort(PortableFieldReference):
    direction: Literal["asc", "desc"] = "asc"


class PortableQueryDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    version: Literal[1] = 1
    columns: list[PortableFieldReference] = Field(default_factory=list, max_length=100)
    filters: list[PortableQueryFilter] = Field(default_factory=list, max_length=10)
    logic: Literal["and", "or"] = "and"
    sort: list[PortableQuerySort] = Field(default_factory=list, max_length=3)
    search_fields: list[PortableFieldReference] = Field(default_factory=list, max_length=100)
    deleted: Literal["exclude", "include", "only"] = "exclude"
    search: str | None = Field(default=None, max_length=240)

    @model_validator(mode="after")
    def unique_references(self) -> Self:
        for references in (self.columns, self.sort):
            if len({ref.name for ref in references}) != len(references):
                raise ValueError("Duplicate named references are not permitted")
        if self.search is not None:
            self.search = self.search.strip() or None
        return self


def _placeholder(reference: PortableFieldReference | None) -> FieldReference | None:
    return (
        FieldReference(field_id=UUID(int=0), expected_type=reference.expected_type)
        if reference is not None
        else None
    )


class PortableAggregateQuery(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    definition: PortableQueryDefinition
    aggregation: Literal["count", "sum", "average", "min", "max", "distinct"] = "count"
    measure: PortableFieldReference | None = None

    @model_validator(mode="after")
    def valid_measure(self) -> Self:
        AggregateRequest(
            module_id=UUID(int=0),
            definition=QueryDefinition(),
            aggregation=self.aggregation,
            measure=_placeholder(self.measure),
        )
        return self


class PortableGroupedQuery(PortableAggregateQuery):
    mode: Literal["groups"]
    dimension: PortableFieldReference
    date_field: PortableFieldReference | None = None
    from_date: date | None = None
    to_date: date | None = None

    @model_validator(mode="after")
    def valid_window(self) -> Self:
        GroupedAggregateSnapshotQuery(
            module_id=UUID(int=0),
            definition=QueryDefinition(),
            aggregation=self.aggregation,
            measure=_placeholder(self.measure),
            dimension=_placeholder(self.dimension),
            date_field=_placeholder(self.date_field),
            from_date=self.from_date,
            to_date=self.to_date,
        )
        return self


class PortableDateQuery(PortableAggregateQuery):
    mode: Literal["date_series"]
    date_field: PortableFieldReference
    from_date: date
    to_date: date
    bucket: AggregateBucket = "day"

    @model_validator(mode="after")
    def valid_window(self) -> Self:
        if self.date_field.expected_type not in {FieldType.DATE, FieldType.DATETIME}:
            raise ValueError("A date field is required")
        validate_bucket_window(self.from_date, self.to_date, self.bucket)
        return self


class PortableRecordsQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    definition: PortableQueryDefinition


class PortableNormalizedConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1] = 1
    size: Literal["S", "M", "L"]
    refresh: Literal["manual"]
    pinned: StrictBool


class PortableChartConfig(PortableNormalizedConfig):
    chart_type: Literal["bar", "line", "pie"]
    query: PortableGroupedQuery | PortableDateQuery

    @model_validator(mode="after")
    def matching_mode(self) -> Self:
        if (self.chart_type == "line") != (self.query.mode == "date_series"):
            raise ValueError("Chart type must match its query mode")
        return self


class PortableAggregateConfig(PortableNormalizedConfig):
    query: PortableGroupedQuery


class PortableRecordsConfig(PortableNormalizedConfig):
    query: PortableRecordsQuery


class PortableWidget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)
    widget_type: Literal["summary", "workload", "records", "chart"]
    source: PortableWidgetSource
    config: (
        PortableWidgetConfig | PortableChartConfig | PortableAggregateConfig | PortableRecordsConfig
    )

    @model_validator(mode="after")
    def named_widget(self) -> Self:
        if not self.name.strip():
            raise ValueError("Widget name is required")
        if not isinstance(self.config, PortableWidgetConfig):
            expected = {
                "chart": PortableChartConfig,
                "summary": PortableAggregateConfig,
                "workload": PortableAggregateConfig,
                "records": PortableRecordsConfig,
            }
            if not isinstance(self.config, expected[self.widget_type]):
                raise ValueError("Widget type must match the normalized query")
        return self


class PortableBoardConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(max_length=240)
    widgets: list[PortableWidget] = Field(max_length=12)

    @model_validator(mode="after")
    def named_board(self) -> Self:
        if not self.name.strip():
            raise ValueError("A named Board is required")
        return self


class PortableBoardBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["openslate-board"]
    version: Literal[3]
    configuration: PortableBoardConfiguration

    @field_validator("version", mode="before")
    @classmethod
    def integer_version_only(cls, value: object) -> object:
        if type(value) is not int:
            raise ValueError("Bundle version must be an integer")
        return value
