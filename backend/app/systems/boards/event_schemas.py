"""Typed Board event-series and bounded occurrence HTTP contracts."""

from calendar import monthrange
from datetime import date, datetime, timedelta
from enum import StrEnum
from typing import Literal, Self
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

from app.common.listing import SortOrder, StandardListRequest, StandardListResponse
from app.systems.boards.content_links import ContentLink
from app.systems.boards.event_occurrences import MAX_EVENT_OCCURRENCES
from app.systems.boards.models import BoardScope

MAX_WINDOW_DAYS = 42
MAX_REQUESTED_BOARDS = 100


ReminderTiming = Literal["start", "15m", "1d"]


def _distinct_timings(value: list[ReminderTiming] | None) -> list[ReminderTiming] | None:
    if value is not None and len(set(value)) != len(value):
        raise ValueError("Each reminder timing can appear once")
    return value


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

    def require_bounded_occurrences(self) -> None:
        """Admit saves only when every supported calendar window fits the reader bound.

        Call after temporal validation, not while reading stored definitions: those
        must remain readable so their authors can correct them.
        """

        if self.recurrence == "none":
            return
        assert self.repeat_until is not None
        if self.all_day:
            assert self.start_date is not None and self.end_date is not None
            anchor = self.start_date
            lookback = (self.end_date - self.start_date).days
        else:
            assert self.start_at is not None and self.end_at is not None
            local = self.start_at.astimezone(ZoneInfo(self.timezone_name))
            anchor = local.date()
            wall_time = timedelta(
                hours=local.hour, minutes=local.minute, seconds=local.second,
                microseconds=local.microsecond,
            )
            days, remainder = divmod(self.end_at - self.start_at + wall_time, timedelta(days=1))
            # Cover offset changes while retaining the reader's fixed local start time.
            lookback = days + bool(remainder) + 1

        required_span = {
            "daily": MAX_EVENT_OCCURRENCES,
            "weekly": 7 * MAX_EVENT_OCCURRENCES,
            "monthly": 365 * (MAX_EVENT_OCCURRENCES // 12) + 28 * (MAX_EVENT_OCCURRENCES % 12),
        }[self.recurrence]
        # A shorter candidate-date span cannot contain 101 recurrence starts.
        if MAX_WINDOW_DAYS - 1 + lookback < required_span:
            return

        elapsed_days = (self.repeat_until - anchor).days
        if self.recurrence == "daily":
            count = 1 + elapsed_days
        elif self.recurrence == "weekly":
            count = 1 + elapsed_days // 7
        else:
            count = 0
            month = anchor.replace(day=1)
            while month <= self.repeat_until:
                if (
                    anchor.day <= monthrange(month.year, month.month)[1]
                    and month.replace(day=anchor.day) <= self.repeat_until
                ):
                    count += 1
                if count > MAX_EVENT_OCCURRENCES or (
                    month.year == date.max.year and month.month == 12
                ):
                    break
                month = (
                    date(month.year + 1, 1, 1)
                    if month.month == 12
                    else date(month.year, month.month + 1, 1)
                )
        if count > MAX_EVENT_OCCURRENCES:
            raise ValueError(
                f"Recurring events must fit within {MAX_EVENT_OCCURRENCES} occurrences "
                "per calendar window"
            )


class EventCreate(EventDefinition):
    board_revision: int = Field(ge=1)
    reminders: list[ReminderTiming] = Field(default_factory=list, max_length=3)

    @field_validator("reminders")
    @classmethod
    def distinct_reminders(cls, value: list[ReminderTiming]) -> list[ReminderTiming]:
        return _distinct_timings(value) or []

    @model_validator(mode="after")
    def bounded_occurrences(self) -> Self:
        self.require_bounded_occurrences()
        return self


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
    reminders: list[ReminderTiming] | None = Field(default=None, max_length=3)

    @field_validator("reminders")
    @classmethod
    def distinct_reminders(cls, value: list[ReminderTiming] | None) -> list[ReminderTiming] | None:
        return _distinct_timings(value)

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
    reminders: list[ReminderTiming]
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


class _OccurrenceWindow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    window_start: date
    window_end: date
    limit: int = Field(default=100, ge=1, le=100)
    offset: int = Field(default=0, ge=0)
    search: str | None = Field(default=None, min_length=1, max_length=100)

    @field_validator("search", mode="before")
    @classmethod
    def normalize_search(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value

    @model_validator(mode="after")
    def bounded_window(self) -> Self:
        if (
            self.window_end < self.window_start
            or (self.window_end - self.window_start).days + 1 > MAX_WINDOW_DAYS
        ):
            raise ValueError("Choose an inclusive window of at most 42 days")
        return self


class OccurrenceRequest(_OccurrenceWindow):
    pass


class CrossBoardOccurrenceRequest(_OccurrenceWindow):
    """The shared list page limit (at most 100) applies to the merged occurrences."""

    board_id: list[UUID] = Field(default_factory=list, max_length=MAX_REQUESTED_BOARDS)


class OccurrenceSummary(BaseModel):
    """One occurrence without its event: the calendar's next-event pointer."""

    id: str
    event_id: str
    start: str
    end: str
    date: str


class OccurrenceResponse(OccurrenceSummary):
    event: EventResponse


class OccurrenceListResponse(StandardListResponse[OccurrenceResponse]):
    board_revision: int
    next_occurrence: OccurrenceSummary | None


class OccurrenceBoard(BaseModel):
    id: UUID
    name: str
    scope: BoardScope
    department_id: UUID | None


class CrossBoardOccurrenceResponse(OccurrenceResponse):
    board: OccurrenceBoard


class BoardOccurrenceStatus(StrEnum):
    OK = "ok"
    CANDIDATE_LIMIT = "candidate_limit"
    OCCURRENCE_LIMIT = "occurrence_limit"
    UNAVAILABLE = "unavailable"


class BoardOccurrenceState(BaseModel):
    """One requested or readable Board; a refused Board says only ``unavailable``."""

    board_id: UUID
    revision: int | None
    status: BoardOccurrenceStatus
    next_occurrence: OccurrenceSummary | None


class CrossBoardOccurrenceListResponse(StandardListResponse[CrossBoardOccurrenceResponse]):
    boards: list[BoardOccurrenceState]
