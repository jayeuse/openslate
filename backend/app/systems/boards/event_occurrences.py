"""Bounded, deterministic occurrence expansion for persisted Board events."""

from calendar import monthrange
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.systems.boards.event_models import BoardEvent

MAX_OCCURRENCE_WINDOW_DAYS = 366
MAX_EVENT_OCCURRENCES = 100
_RECURRENCES = frozenset({"none", "daily", "weekly", "monthly"})


@dataclass(frozen=True, slots=True)
class BoardEventOccurrence:
    id: str
    event_id: str
    start: str
    end: str
    date: str


@dataclass(frozen=True, slots=True)
class BoardEventOccurrenceResult:
    occurrences: tuple[BoardEventOccurrence, ...]
    truncated: bool


@dataclass(frozen=True, slots=True)
class _EventSpec:
    event_id: UUID
    all_day: bool
    start_date: date
    start_at: datetime | None
    end_at: datetime | None
    timezone: ZoneInfo
    recurrence: str
    repeat_until: date | None
    duration_days: int
    duration: timedelta
    local_start_time: time | None


def _utc_instant(value: object) -> datetime | None:
    if not isinstance(value, datetime) or value.tzinfo is None:
        return None
    try:
        if value.utcoffset() != timedelta(0):
            return None
        return value.astimezone(UTC)
    except (OverflowError, OSError, TypeError, ValueError):
        return None


def _zone(value: object) -> ZoneInfo | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return ZoneInfo(value)
    except (TypeError, ValueError, ZoneInfoNotFoundError):
        return None


def _date(value: object) -> date | None:
    return value if type(value) is date else None


def _event_spec(event: BoardEvent) -> _EventSpec | None:
    """Validate the stored temporal union before doing date arithmetic."""

    try:
        event_id = event.id
        all_day = event.all_day
        zone = _zone(event.timezone_name)
        recurrence = event.recurrence
        repeat_until = _date(event.repeat_until)
    except (AttributeError, TypeError, ValueError):
        return None

    if not isinstance(event_id, UUID) or type(all_day) is not bool or zone is None:
        return None
    if not isinstance(recurrence, str) or recurrence not in _RECURRENCES:
        return None
    if recurrence == "none":
        if event.repeat_until is not None:
            return None
    elif repeat_until is None:
        return None

    if all_day:
        start_date = _date(event.start_date)
        end_date = _date(event.end_date)
        if (
            start_date is None
            or end_date is None
            or event.start_at is not None
            or event.end_at is not None
            or end_date < start_date
        ):
            return None
        duration_days = (end_date - start_date).days + 1
        if repeat_until is not None and repeat_until < start_date:
            return None
        return _EventSpec(
            event_id=event_id,
            all_day=True,
            start_date=start_date,
            start_at=None,
            end_at=None,
            timezone=zone,
            recurrence=recurrence,
            repeat_until=repeat_until,
            duration_days=duration_days,
            duration=timedelta(days=duration_days),
            local_start_time=None,
        )

    if event.start_date is not None or event.end_date is not None:
        return None
    start_at = _utc_instant(event.start_at)
    end_at = _utc_instant(event.end_at)
    if start_at is None or end_at is None or end_at <= start_at:
        return None
    try:
        start_date = start_at.astimezone(zone).date()
        local_start_time = start_at.astimezone(zone).timetz().replace(tzinfo=None, fold=0)
    except (OverflowError, OSError, TypeError, ValueError):
        return None
    if repeat_until is not None and repeat_until < start_date:
        return None
    return _EventSpec(
        event_id=event_id,
        all_day=False,
        start_date=start_date,
        start_at=start_at,
        end_at=end_at,
        timezone=zone,
        recurrence=recurrence,
        repeat_until=repeat_until,
        duration_days=0,
        duration=end_at - start_at,
        local_start_time=local_start_time,
    )


def _valid_window(window_start: object, window_end: object) -> bool:
    if type(window_start) is not date or type(window_end) is not date:
        return False
    return (
        window_end >= window_start
        and (window_end - window_start).days + 1 <= MAX_OCCURRENCE_WINDOW_DAYS
    )


def _compatible_local_instant(day: date, local_time: time, zone: ZoneInfo) -> datetime | None:
    """Use Temporal-compatible disambiguation: earlier fold, forward through gaps."""

    try:
        wall = datetime.combine(day, local_time).replace(tzinfo=zone, fold=0)
        return wall.astimezone(UTC)
    except (OverflowError, OSError, TypeError, ValueError):
        return None


def _timed_window(
    window_start: date, window_end: date, zone: ZoneInfo
) -> tuple[datetime, datetime] | None:
    start = _compatible_local_instant(window_start, time.min, zone)
    if window_end == date.max:
        end: datetime | None = datetime.max.replace(tzinfo=UTC)
    else:
        end = _compatible_local_instant(window_end + timedelta(days=1), time.min, zone)
    if start is None or end is None or end <= start:
        return None
    return start, end


def _recurrence_search_start(
    spec: _EventSpec, window_start: date, window_start_instant: datetime | None
) -> date:
    if spec.all_day:
        try:
            return window_start - timedelta(days=spec.duration_days - 1)
        except OverflowError:
            return spec.start_date
    if window_start_instant is None:
        return spec.start_date
    try:
        return (window_start_instant - spec.duration).astimezone(spec.timezone).date() - timedelta(
            days=1
        )
    except (OverflowError, OSError, TypeError, ValueError):
        return spec.start_date


def _format_instant(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _occurrence(
    spec: _EventSpec,
    occurrence_date: date,
    *,
    recurring: bool,
    start_at: datetime | None = None,
    end_at: datetime | None = None,
) -> BoardEventOccurrence | None:
    if spec.all_day:
        try:
            end_date = occurrence_date + timedelta(days=spec.duration_days - 1)
        except OverflowError:
            return None
        return BoardEventOccurrence(
            id=f"{spec.event_id}:{occurrence_date.isoformat()}",
            event_id=str(spec.event_id),
            start=occurrence_date.isoformat(),
            end=end_date.isoformat(),
            date=occurrence_date.isoformat(),
        )

    if start_at is None or end_at is None:
        return None
    stable_key = occurrence_date.isoformat() if recurring else _format_instant(start_at)
    return BoardEventOccurrence(
        id=f"{spec.event_id}:{stable_key}",
        event_id=str(spec.event_id),
        start=_format_instant(start_at),
        end=_format_instant(end_at),
        date=occurrence_date.isoformat(),
    )


def expand_board_event_occurrences(
    event: BoardEvent,
    window_start: date,
    window_end: date,
    *,
    requested_limit: int = MAX_EVENT_OCCURRENCES,
) -> BoardEventOccurrenceResult:
    """Expand one event over an inclusive window of at most 366 calendar days.

    Invalid windows and corrupt stored temporal rows fail closed with no results.
    Monthly recurrences skip months without the original day; a full result limit
    is marked truncated only when another matching occurrence exists in-window.
    """

    if not _valid_window(window_start, window_end):
        return BoardEventOccurrenceResult(occurrences=(), truncated=False)
    spec = _event_spec(event)
    if spec is None:
        return BoardEventOccurrenceResult(occurrences=(), truncated=False)
    limit = (
        min(MAX_EVENT_OCCURRENCES, max(1, requested_limit))
        if type(requested_limit) is int
        else MAX_EVENT_OCCURRENCES
    )

    timed_bounds = None if spec.all_day else _timed_window(window_start, window_end, spec.timezone)
    if not spec.all_day and timed_bounds is None:
        return BoardEventOccurrenceResult(occurrences=(), truncated=False)

    occurrences: list[BoardEventOccurrence] = []
    truncated = False

    def add(day: date, *, recurring: bool) -> bool:
        nonlocal truncated
        if spec.all_day:
            try:
                occurrence_end_date = day + timedelta(days=spec.duration_days - 1)
            except OverflowError:
                return False
            if day > window_end or occurrence_end_date < window_start:
                return False
            occurrence = _occurrence(spec, day, recurring=recurring)
        else:
            occurrence_start: datetime | None
            occurrence_end: datetime | None
            if recurring:
                if spec.local_start_time is None:
                    return False
                occurrence_start = _compatible_local_instant(
                    day, spec.local_start_time, spec.timezone
                )
                if occurrence_start is None:
                    return False
                try:
                    occurrence_end = occurrence_start + spec.duration
                except OverflowError:
                    return False
            else:
                occurrence_start = spec.start_at
                occurrence_end = spec.end_at
            if (
                occurrence_start is None
                or occurrence_end is None
                or timed_bounds is None
                or occurrence_start >= timed_bounds[1]
                or occurrence_end <= timed_bounds[0]
            ):
                return False
            occurrence = _occurrence(
                spec,
                day,
                recurring=recurring,
                start_at=occurrence_start,
                end_at=occurrence_end,
            )

        if occurrence is None:
            return False
        if len(occurrences) >= limit:
            truncated = True
            return True
        occurrences.append(occurrence)
        return False

    if spec.recurrence == "none":
        add(spec.start_date, recurring=False)
        return BoardEventOccurrenceResult(tuple(occurrences), truncated)

    if spec.repeat_until is None:
        return BoardEventOccurrenceResult(occurrences=(), truncated=False)
    search_start = _recurrence_search_start(
        spec,
        window_start,
        None if timed_bounds is None else timed_bounds[0],
    )
    first_date = max(spec.start_date, search_start)
    last_date = min(window_end, spec.repeat_until)
    if first_date > last_date:
        return BoardEventOccurrenceResult(tuple(occurrences), truncated)

    if spec.recurrence == "monthly":
        anchor_day = spec.start_date.day
        month = first_date.replace(day=1)
        while month <= last_date:
            if anchor_day <= monthrange(month.year, month.month)[1]:
                candidate = month.replace(day=anchor_day)
                if first_date <= candidate <= last_date and add(candidate, recurring=True):
                    break
            if month.year == date.max.year and month.month == 12:
                break
            month = (
                date(month.year + 1, 1, 1)
                if month.month == 12
                else date(month.year, month.month + 1, 1)
            )
    else:
        step_days = 7 if spec.recurrence == "weekly" else 1
        elapsed_days = (first_date - spec.start_date).days
        periods = (elapsed_days + step_days - 1) // step_days
        try:
            candidate = spec.start_date + timedelta(days=periods * step_days)
        except OverflowError:
            return BoardEventOccurrenceResult(tuple(occurrences), truncated)
        while candidate <= last_date:
            if add(candidate, recurring=True):
                break
            if (last_date - candidate).days < step_days:
                break
            candidate += timedelta(days=step_days)

    return BoardEventOccurrenceResult(tuple(occurrences), truncated)
