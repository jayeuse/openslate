"""Typed Board event-series and bounded occurrence HTTP contracts."""

from datetime import date, datetime, timedelta
from enum import StrEnum
from typing import Literal, Self
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from app.common.listing import SortOrder, StandardListRequest, StandardListResponse
from app.systems.boards.content_links import ContentLink

MAX_WINDOW_DAYS = 42


class EventAudience(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["everyone", "author", "role", "user", "department"] = "everyone"
    role_id: UUID | None = None
    user_id: UUID | None = None
    department_id: UUID | None = None

    @model_validator(mode="after")
    def one_target(self) -> Self:
        targets = (self.role_id, self.user_id, self.department_id)
        expected = {"role": 0, "user": 1, "department": 2}.get(self.kind)
        if (
            any(value is not None for value in targets)
            if expected is None
            else any((value is None) == (index == expected) for index, value in enumerate(targets))
        ):
            raise ValueError("Audience target must match its kind")
        return self


class EventDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=100)
    details: str = Field(default="", max_length=4000)
    location: str = Field(default="", max_length=240)
    links: list[ContentLink] = Field(default_factory=list, max_length=20)
    all_day: StrictBool
    start_date: date | None = None
    end_date: date | None = None
    start_at: datetime | None = None
    end_at: datetime | None = None
    timezone_name: str = Field(min_length=1, max_length=80)
    recurrence: Literal["none", "daily", "weekly", "monthly"] = "none"
    repeat_until: date | None = None
    audience: EventAudience = Field(default_factory=EventAudience)

    @model_validator(mode="after")
    def valid_time(self) -> Self:
        try:
            zone = ZoneInfo(self.timezone_name)
        except (ValueError, ZoneInfoNotFoundError) as error:
            raise ValueError("Choose a valid IANA timezone") from error
        if self.all_day:
            if (
                self.start_date is None
                or self.end_date is None
                or self.start_at is not None
                or self.end_at is not None
                or self.end_date < self.start_date
            ):
                raise ValueError("All-day events require ordered dates only")
            anchor = self.start_date
        else:
            start, end = self.start_at, self.end_at
            if (
                self.start_date is not None
                or self.end_date is not None
                or start is None
                or end is None
                or start.tzinfo is None
                or end.tzinfo is None
                or start.utcoffset() != timedelta(0)
                or end.utcoffset() != timedelta(0)
                or end <= start
            ):
                raise ValueError("Timed events require ordered UTC instants only")
            anchor = start.astimezone(zone).date()
        if (self.recurrence == "none") != (self.repeat_until is None):
            raise ValueError("Recurrence and ending date must agree")
        if self.repeat_until is not None and self.repeat_until < anchor:
            raise ValueError("Recurrence ends before the event starts")
        return self


class EventCreate(EventDefinition):
    board_revision: int = Field(ge=1)


class EventPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    board_revision: int = Field(ge=1)
    event_revision: int = Field(ge=1)
    title: str | None = None
    details: str | None = None
    location: str | None = None
    links: list[ContentLink] | None = Field(default=None, max_length=20)
    all_day: StrictBool | None = None
    start_date: date | None = None
    end_date: date | None = None
    start_at: datetime | None = None
    end_at: datetime | None = None
    timezone_name: str | None = None
    recurrence: Literal["none", "daily", "weekly", "monthly"] | None = None
    repeat_until: date | None = None
    audience: EventAudience | None = None

    @model_validator(mode="after")
    def changed(self) -> Self:
        if not self.model_fields_set - {"board_revision", "event_revision"}:
            raise ValueError("At least one event field is required")
        return self


class EventRevisionWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    board_revision: int = Field(ge=1)
    event_revision: int = Field(ge=1)


class EventSort(StrEnum):
    CREATED_AT = "created_at"
    TITLE = "title"


class EventArchiveFilter(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"
    ALL = "all"


class EventListRequest(StandardListRequest[EventSort]):
    sort_order: SortOrder = SortOrder.DESC
    archived: EventArchiveFilter = EventArchiveFilter.ACTIVE


class EventResponse(BaseModel):
    id: UUID
    board_id: UUID
    author_id: UUID
    title: str
    details: str
    location: str
    links: list[ContentLink]
    all_day: bool
    start_date: date | None
    end_date: date | None
    start_at: datetime | None
    end_at: datetime | None
    timezone_name: str
    recurrence: str
    repeat_until: date | None
    audience: EventAudience
    archived: bool
    revision: int
    board_revision: int
    created_at: datetime
    updated_at: datetime


class EventListResponse(StandardListResponse[EventResponse]):
    board_revision: int


class EventMutationResponse(BaseModel):
    id: UUID
    event_revision: int
    board_revision: int


class OccurrenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    window_start: date
    window_end: date
    limit: int = Field(default=100, ge=1, le=100)
    offset: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def bounded_window(self) -> Self:
        if (
            self.window_end < self.window_start
            or (self.window_end - self.window_start).days + 1 > MAX_WINDOW_DAYS
        ):
            raise ValueError("Choose an inclusive window of at most 42 days")
        return self


class OccurrenceResponse(BaseModel):
    id: str
    event_id: str
    start: str
    end: str
    date: str
    event: EventResponse


class OccurrenceListResponse(StandardListResponse[OccurrenceResponse]):
    board_revision: int
