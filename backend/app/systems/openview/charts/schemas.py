"""Strict contracts for a current user's live Chart settings."""

from datetime import date
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.systems.sandbox.records.query_schemas import QueryFilter


class ChartPreferenceConfig(BaseModel):
    """A versioned Chart form configuration; it never contains result rows."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    version: Literal[1] = 1
    module_id: UUID
    chart_type: Literal["bar", "line", "pie"]
    dimension_id: UUID | None = None
    date_field_id: UUID | None = None
    aggregation: Literal["count", "sum", "average"]
    measure_id: UUID | None = None
    filter_logic: Literal["and", "or"] = "and"
    filters: list[QueryFilter] = Field(default_factory=list, max_length=10)
    from_date: date | None = None
    to_date: date | None = None
    top: Literal[5, 10, 20, 50] | None = None
    show_legend: bool = True
    show_values: bool = True

    @model_validator(mode="after")
    def validate_chart_settings(self) -> Self:
        if self.aggregation == "count":
            if self.measure_id is not None:
                raise ValueError("Count does not accept a measure field")
        elif self.measure_id is None:
            raise ValueError("Sum and average require a numeric measure field")

        if self.chart_type == "line":
            if (
                self.dimension_id is not None
                or self.date_field_id is None
                or self.from_date is None
                or self.to_date is None
            ):
                raise ValueError("Line charts require a date field and bounded date window")
            if self.top is not None:
                raise ValueError("Top applies only to categorical previews")
        elif self.dimension_id is None:
            raise ValueError("Categorical charts require a dimension field")

        if (self.from_date is None) != (self.to_date is None):
            raise ValueError("Date windows require both start and end dates")
        if (self.from_date is not None or self.to_date is not None) and self.date_field_id is None:
            raise ValueError("Date windows require a date field")
        if self.from_date is not None and self.to_date is not None:
            days = (self.to_date - self.from_date).days + 1
            if days < 1 or days > 366:
                raise ValueError("Date windows must contain between 1 and 366 days")
        return self


class ChartPreferenceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    config: ChartPreferenceConfig


class ChartPreferenceResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    config: ChartPreferenceConfig | None
