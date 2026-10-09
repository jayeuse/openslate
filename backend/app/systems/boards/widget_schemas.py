"""Typed Board widget configuration and revisioned mutation contracts."""

from datetime import datetime
from enum import StrEnum
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.common.listing import StandardListRequest
from app.common.listing.schemas import PaginationMetadata
from app.systems.openview.dashboards.schemas import (
    DashboardWidgetConfig,
    _configuration_matches_widget,
)
from app.systems.sandbox.records.query_schemas import (
    AggregateRequest,
    FieldReference,
    QueryDefinition,
    QueryFilter,
)


class BoardWidgetConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    version: Literal[1] = 1
    fields: list[FieldReference] = Field(default_factory=list, max_length=24)
    filters: list[QueryFilter] = Field(default_factory=list, max_length=8)
    logic: Literal["and", "or"] = "and"
    aggregation: Literal["count", "sum", "average", "min", "max", "distinct"] = "count"
    metric: FieldReference | None = None
    visualization: Literal["bar", "line", "pie"] = "bar"
    refresh: Literal["manual", "one-minute", "five-minutes"] = "manual"

    @model_validator(mode="after")
    def validate_references(self) -> Self:
        if len({item.field_id for item in self.fields}) != len(self.fields):
            raise ValueError("Widget fields must be distinct")
        if "aggregation" not in self.model_fields_set:
            # Pre-aggregation JSON retains its count/sum projection without a backfill.
            self.aggregation = "sum" if self.metric is not None else "count"
        AggregateRequest(
            module_id=UUID(int=0),
            definition=QueryDefinition(),
            aggregation=self.aggregation,
            measure=self.metric,
        )
        return self


BoardInlineConfig = BoardWidgetConfig | DashboardWidgetConfig


class BoardWidgetSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=80)
    widget_type: Literal["summary", "workload", "records", "chart"]
    module_id: UUID
    size: Literal["S", "M", "L"] = "M"
    pinned: bool = False
    chart_id: UUID | None = None
    config: BoardInlineConfig | None = None

    @model_validator(mode="after")
    def validate_source(self) -> Self:
        if (self.config is None) == (self.chart_id is None):
            raise ValueError("Exactly one widget config or Chart reference is required")
        if self.config is not None and not isinstance(self.config, BoardWidgetConfig):
            if not _configuration_matches_widget(self.widget_type, self.config):
                raise ValueError("Widget config does not match its type")
            if self.config.query.module_id != self.module_id:
                raise ValueError("Widget query must use its selected module")
        return self


class BoardWidgetWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)
    widget: BoardWidgetSpec


class BoardWidgetOrder(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)
    widget_ids: list[UUID] = Field(min_length=1, max_length=12)

    @model_validator(mode="after")
    def unique_ids(self) -> Self:
        if len(set(self.widget_ids)) != len(self.widget_ids):
            raise ValueError("Widget order must contain distinct IDs")
        return self


class BoardWidgetRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)


class BoardWidgetSort(StrEnum):
    POSITION = "position"
    CREATED_AT = "created_at"


class BoardWidgetListRequest(StandardListRequest[BoardWidgetSort]):
    pass


class BoardWidgetResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    board_id: UUID
    name: str
    widget_type: Literal["summary", "workload", "records", "chart"]
    module_id: UUID
    position: int = Field(ge=0, lt=12)
    size: Literal["S", "M", "L"]
    pinned: bool
    chart_id: UUID | None
    config: BoardInlineConfig | None
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def validate_source(self) -> Self:
        if (self.config is None) == (self.chart_id is None):
            raise ValueError("Exactly one widget config or Chart reference is required")
        if self.config is not None and not isinstance(self.config, BoardWidgetConfig):
            if not _configuration_matches_widget(self.widget_type, self.config):
                raise ValueError("Widget config does not match its type")
            if self.config.query.module_id != self.module_id:
                raise ValueError("Widget query must use its selected module")
        return self


class BoardWidgetMutationResponse(BaseModel):
    widget: BoardWidgetResponse
    board_revision: int


class BoardWidgetListResponse(BaseModel):
    items: list[BoardWidgetResponse] = Field(max_length=12)
    pagination: PaginationMetadata
    board_revision: int


class BoardWidgetOrderResponse(BaseModel):
    items: list[BoardWidgetResponse] = Field(max_length=12)
    board_revision: int
