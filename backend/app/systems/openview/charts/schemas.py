"""Strict saved Chart definitions and revisioned, module-readable HTTP contracts."""

from datetime import datetime
from enum import StrEnum
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.common.listing import StandardListRequest, StandardListResponse
from app.systems.openview.dashboards.schemas import DashboardRecordsQuery
from app.systems.sandbox.records.query_schemas import (
    AggregateSnapshotQuery,
    DateSeriesAggregateQuery,
    GroupedAggregateSnapshotQuery,
)

ChartType = Literal["bar", "line", "pie", "summary", "workload", "records"]
ChartQuery = AggregateSnapshotQuery | DashboardRecordsQuery


class ChartDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    chart_type: ChartType
    query: ChartQuery

    @model_validator(mode="after")
    def matching_query_family(self) -> Self:
        expected = (
            DashboardRecordsQuery
            if self.chart_type == "records"
            else DateSeriesAggregateQuery
            if self.chart_type == "line"
            else GroupedAggregateSnapshotQuery
        )
        if not isinstance(self.query, expected):
            raise ValueError("Chart type does not match its query family")
        return self


class ChartCreate(ChartDefinition):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, allow_inf_nan=False)

    module_id: UUID
    name: str = Field(min_length=1, max_length=120)

    @model_validator(mode="after")
    def matching_module(self) -> Self:
        if self.module_id != self.query.module_id:
            raise ValueError("Chart and query require the same module")
        return self


class ChartUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, allow_inf_nan=False)

    revision: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=120)
    chart_type: ChartType | None = None
    query: ChartQuery | None = None

    @model_validator(mode="after")
    def require_valid_change(self) -> Self:
        changed = self.model_fields_set - {"revision"}
        if not changed or any(getattr(self, name) is None for name in changed):
            raise ValueError("At least one non-null Chart change is required")
        if self.chart_type is not None and self.query is not None:
            ChartDefinition(chart_type=self.chart_type, query=self.query)
        return self


class ChartRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)


class ChartResponse(ChartDefinition):
    id: UUID
    department_id: UUID
    module_id: UUID
    name: str
    revision: int = Field(ge=1)
    is_deleted: bool
    created_at: datetime
    updated_at: datetime


class ChartSort(StrEnum):
    NAME = "name"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class ChartListRequest(StandardListRequest[ChartSort]):
    module_id: UUID | None = None
    department_id: UUID | None = None


class ChartUsageSort(StrEnum):
    NAME = "name"


class ChartUsageRequest(StandardListRequest[ChartUsageSort]):
    pass


class ChartUsageItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["board", "dashboard"]
    id: UUID
    name: str


class ChartUsageResponse(StandardListResponse[ChartUsageItem]):
    has_restricted_usage: bool
