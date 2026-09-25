"""Strict contracts for revisioned, private dashboards and chart widgets."""

from datetime import datetime
from enum import StrEnum
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.common.listing.schemas import StandardListRequest
from app.systems.sandbox.records.query_schemas import (
    AggregateSnapshotQuery,
    GroupedAggregateSnapshotQuery,
    QueryDefinition,
)

DashboardRefreshCadence = Literal["manual", "one-minute", "five-minutes"]
DashboardWidgetType = Literal["summary", "workload", "records", "chart"]


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
    """One live widget; list order supplies its persisted position."""

    model_config = ConfigDict(extra="forbid")

    widget_type: DashboardWidgetType
    config: DashboardWidgetConfig

    @model_validator(mode="after")
    def config_matches_widget_type(self) -> Self:
        if not _configuration_matches_widget(self.widget_type, self.config):
            raise ValueError("Dashboard widget config does not match its widget type")
        return self


class DashboardCreate(BaseModel):
    """Create an owner-private Dashboard with up to twelve live widgets."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=200)
    refresh_cadence: DashboardRefreshCadence = "manual"
    widgets: list[DashboardWidgetSpec] = Field(default_factory=list, max_length=12)


class DashboardUpdate(BaseModel):
    """Full revision-checked Dashboard patch; an empty widget list clears it."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    revision: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    refresh_cadence: DashboardRefreshCadence | None = None
    widgets: list[DashboardWidgetSpec] | None = Field(default=None, max_length=12)

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
    NAME = "name"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class DashboardListRequest(StandardListRequest[DashboardSort]):
    """Bounded offset pagination and allowlisted Dashboard ordering."""


class DashboardWidgetResponse(BaseModel):
    """One persisted live widget without a materialized data snapshot."""

    model_config = ConfigDict(extra="forbid")

    id: UUID
    position: int = Field(ge=0, lt=12)
    widget_type: DashboardWidgetType
    config: DashboardWidgetConfig
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def config_matches_widget_type(self) -> Self:
        if not _configuration_matches_widget(self.widget_type, self.config):
            raise ValueError("Dashboard widget config does not match its widget type")
        return self


class DashboardResponse(BaseModel):
    """Owner-private Dashboard metadata and its active ordered widgets."""

    model_config = ConfigDict(extra="forbid")

    id: UUID
    owner_id: UUID
    name: str
    refresh_cadence: DashboardRefreshCadence
    revision: int = Field(ge=1)
    is_deleted: bool
    created_at: datetime
    updated_at: datetime
    widgets: list[DashboardWidgetResponse] = Field(max_length=12)


class DashboardDefaultSet(BaseModel):
    """Set a user's default Dashboard, or clear it with an explicit null."""

    model_config = ConfigDict(extra="forbid")

    dashboard_id: UUID | None


class DashboardDefaultResponse(BaseModel):
    """Current user's Dashboard default; null means no Dashboard is selected."""

    model_config = ConfigDict(extra="forbid")

    dashboard_id: UUID | None
