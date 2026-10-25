"""Strict contracts for revisioned department Dashboards and their widgets."""

from datetime import datetime
from enum import StrEnum
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.common.listing.schemas import StandardListRequest
from app.systems.openview.dashboards.placement import GRID_CELLS, GRID_COLUMNS, GRID_ROWS
from app.systems.sandbox.records.query_schemas import (
    AggregateSnapshotQuery,
    GroupedAggregateSnapshotQuery,
    QueryDefinition,
)

DashboardRefreshCadence = Literal["manual", "one-minute", "five-minutes"]
DashboardWidgetType = Literal["summary", "workload", "records", "chart"]
DASHBOARD_POSITION_MAX = 10_000
# Every widget covers at least one cell of the 4 x 5 grid.
DASHBOARD_WIDGET_LIMIT = GRID_CELLS


class DashboardChartConfig(BaseModel):
    """Saved chart instructions; results are fetched as a fresh snapshot."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    version: Literal[1] = 1
    chart_type: Literal["bar", "line", "pie"]
    query: AggregateSnapshotQuery

    @model_validator(mode="after")
    def chart_matches_snapshot_mode(self) -> Self:
        if (self.chart_type == "line") != (self.query.mode == "date_series"):
            raise ValueError("Line charts require date series; bar and pie charts require groups")
        return self


class DashboardAggregateConfig(BaseModel):
    """Saved grouped aggregate instructions for Summary and Workload widgets."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    version: Literal[1] = 1
    query: GroupedAggregateSnapshotQuery


class DashboardRecordsQuery(BaseModel):
    """Saved live Record list query; paging is bounded by the renderer."""

    model_config = ConfigDict(extra="forbid")

    module_id: UUID
    definition: QueryDefinition


class DashboardRecordsConfig(BaseModel):
    """Saved Record list instructions, without persisted business data."""

    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    query: DashboardRecordsQuery


DashboardWidgetConfig = DashboardChartConfig | DashboardAggregateConfig | DashboardRecordsConfig


def _configuration_matches_widget(widget_type: str, config: DashboardWidgetConfig) -> bool:
    expected = {
        "chart": DashboardChartConfig,
        "summary": DashboardAggregateConfig,
        "workload": DashboardAggregateConfig,
        "records": DashboardRecordsConfig,
    }
    return isinstance(config, expected[widget_type])


class DashboardWidgetSpec(BaseModel):
    """One live widget at whole grid cells; list order supplies its persisted position."""

    model_config = ConfigDict(extra="forbid")

    widget_type: DashboardWidgetType
    grid_column: int = Field(ge=0, le=GRID_COLUMNS - 1)
    grid_row: int = Field(ge=0, le=GRID_ROWS - 1)
    column_span: int = Field(ge=1, le=GRID_COLUMNS)
    row_span: int = Field(ge=1, le=GRID_ROWS)
    chart_id: UUID | None = None
    config: DashboardWidgetConfig | None = None

    @model_validator(mode="after")
    def config_matches_widget_type(self) -> Self:
        if (self.config is None) == (self.chart_id is None):
            raise ValueError("Exactly one widget config or Chart reference is required")
        if self.config is not None and not _configuration_matches_widget(
            self.widget_type, self.config
        ):
            raise ValueError("Dashboard widget config does not match its widget type")
        return self


class DashboardCreate(BaseModel):
    """Create a department Dashboard; its widgets must fit the grid without overlap."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    department_id: UUID
    name: str = Field(min_length=1, max_length=200)
    position: int = Field(default=0, ge=0, le=DASHBOARD_POSITION_MAX)
    refresh_cadence: DashboardRefreshCadence = "manual"
    widgets: list[DashboardWidgetSpec] = Field(
        default_factory=list, max_length=DASHBOARD_WIDGET_LIMIT
    )


class DashboardUpdate(BaseModel):
    """Full revision-checked Dashboard patch; an empty widget list clears it."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    revision: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    position: int | None = Field(default=None, ge=0, le=DASHBOARD_POSITION_MAX)
    refresh_cadence: DashboardRefreshCadence | None = None
    widgets: list[DashboardWidgetSpec] | None = Field(
        default=None, max_length=DASHBOARD_WIDGET_LIMIT
    )

    @model_validator(mode="after")
    def require_nonempty_update(self) -> Self:
        changed = self.model_fields_set - {"revision"}
        if not changed or any(getattr(self, name) is None for name in changed):
            raise ValueError("At least one non-null Dashboard change is required")
        return self


class DashboardRestore(BaseModel):
    """Revision precondition for restoring an archived Dashboard."""

    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)


class DashboardSort(StrEnum):
    POSITION = "position"
    NAME = "name"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class DashboardListRequest(StandardListRequest[DashboardSort]):
    """Bounded offset pagination, allowlisted ordering, a department and the home filter."""

    department_id: UUID | None = None
    home: bool | None = None


class DashboardWidgetResponse(BaseModel):
    """One persisted live widget without a materialized data snapshot.

    A widget the grid migration could not place has no placement (all four null).
    """

    model_config = ConfigDict(extra="forbid")

    id: UUID
    position: int = Field(ge=0, lt=DASHBOARD_WIDGET_LIMIT)
    widget_type: DashboardWidgetType
    grid_column: int | None = Field(ge=0, le=GRID_COLUMNS - 1)
    grid_row: int | None = Field(ge=0, le=GRID_ROWS - 1)
    column_span: int | None = Field(ge=1, le=GRID_COLUMNS)
    row_span: int | None = Field(ge=1, le=GRID_ROWS)
    chart_id: UUID | None
    config: DashboardWidgetConfig | None
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def config_matches_widget_type(self) -> Self:
        if (self.config is None) == (self.chart_id is None):
            raise ValueError("Exactly one widget config or Chart reference is required")
        if self.config is not None and not _configuration_matches_widget(
            self.widget_type, self.config
        ):
            raise ValueError("Dashboard widget config does not match its widget type")
        placement = (self.grid_column, self.grid_row, self.column_span, self.row_span)
        if len({value is None for value in placement}) != 1:
            raise ValueError("A widget placement sets all four grid fields or none")
        return self


class DashboardResponse(BaseModel):
    """Department Dashboard metadata and its active ordered widgets."""

    model_config = ConfigDict(extra="forbid")

    id: UUID
    department_id: UUID
    position: int = Field(ge=0)
    name: str
    refresh_cadence: DashboardRefreshCadence
    revision: int = Field(ge=1)
    is_home: bool
    is_deleted: bool
    created_at: datetime
    updated_at: datetime
    widgets: list[DashboardWidgetResponse] = Field(max_length=DASHBOARD_WIDGET_LIMIT)
