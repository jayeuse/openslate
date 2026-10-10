"""Strict wall-clock policy requests and private Report schedule metadata."""

from datetime import datetime
from typing import Annotated, Literal, Self
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    field_validator,
    model_validator,
)

from app.systems.platform.scheduling.models import WorkState

Cadence = Literal["daily", "weekly", "monthly"]
Weekday = Annotated[StrictInt, Field(ge=0, le=6)]
MonthDay = Annotated[StrictInt, Field(ge=1, le=31)]
LocalTime = Annotated[str, Field(pattern=r"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")]


def _timezone(value: str) -> str:
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        raise ValueError("Use an IANA timezone name") from None
    return value


class ScheduleCreate(BaseModel):
    """A complete policy; the server alone selects its UTC due cursor."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    enabled: StrictBool = False
    cadence: Cadence
    timezone_name: str = Field(min_length=1, max_length=64)
    local_time: LocalTime
    weekday: Weekday | None = None
    month_day: MonthDay | None = None

    @field_validator("timezone_name")
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        return _timezone(value)

    @model_validator(mode="after")
    def anchor_matches_cadence(self) -> Self:
        if not (
            (self.cadence == "daily" and self.weekday is None and self.month_day is None)
            or (self.cadence == "weekly" and self.weekday is not None and self.month_day is None)
            or (self.cadence == "monthly" and self.weekday is None and self.month_day is not None)
        ):
            raise ValueError("Schedule anchor must match cadence")
        return self


class SchedulePatch(BaseModel):
    """Revision-preconditioned policy edit; null clears cadence anchors only."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    revision: StrictInt = Field(ge=1)
    enabled: StrictBool | None = None
    cadence: Cadence | None = None
    timezone_name: str | None = Field(default=None, min_length=1, max_length=64)
    local_time: LocalTime | None = None
    weekday: Weekday | None = None
    month_day: MonthDay | None = None

    @field_validator("timezone_name")
    @classmethod
    def valid_timezone(cls, value: str | None) -> str | None:
        return _timezone(value) if value is not None else None

    @model_validator(mode="after")
    def change_is_present(self) -> Self:
        changed = self.model_fields_set - {"revision"}
        if not changed or any(
            getattr(self, name) is None for name in changed - {"weekday", "month_day"}
        ):
            raise ValueError("At least one non-null policy change is required")
        return self


class ScheduleLastRun(BaseModel):
    state: WorkState
    finished_at: datetime | None
    failure_label: str | None


class ScheduleResponse(BaseModel):
    """Private policy representation; a disabled policy exposes no due instant."""

    model_config = ConfigDict(extra="forbid")

    id: UUID
    report_id: UUID
    revision: int = Field(ge=1)
    enabled: bool
    cadence: Cadence
    timezone_name: str
    local_time: LocalTime
    weekday: int | None
    month_day: int | None
    next_due_at: datetime | None
    last_run: ScheduleLastRun | None
    created_at: datetime
    updated_at: datetime
