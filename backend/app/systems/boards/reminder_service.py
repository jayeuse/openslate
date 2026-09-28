"""Author-set event reminders, their occurrences, and their pending work.

A reminder is a timing of an event ("1 day before"). Each occurrence of the
event gets one ``scheduled_work`` row, keyed by ``(reminder_id,
occurrence_start_at)``, that notifies every reader of the Board when it is due.
The worker queues the next occurrence of each reminder (see
``platform/scheduling/materializer.py``). An edit to the event's time deletes the
pending rows, so the next poll queues them again for the new schedule.
"""

from collections.abc import Iterable
from datetime import UTC, date, datetime, time, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_occurrences import (
    BoardEventOccurrence,
    _compatible_local_instant,
    expand_board_event_occurrences,
)
from app.systems.boards.reminder_models import REMINDER_TIMINGS, BoardEventReminder
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)

OFFSETS = {"start": timedelta(), "15m": timedelta(minutes=15), "1d": timedelta(days=1)}
REMINDER_DELIVERY_GRACE = timedelta(minutes=15)
_SEARCH_STEP_DAYS = 31
_SEARCH_LIMIT_DAYS = 366
TIMING_FIELDS = (
    "all_day",
    "start_date",
    "end_date",
    "start_at",
    "end_at",
    "timezone_name",
    "recurrence",
    "repeat_until",
)


def ordered_timings(timings: Iterable[str]) -> list[str]:
    chosen = set(timings)
    return [timing for timing in REMINDER_TIMINGS if timing in chosen]


def occurrence_instant(event: BoardEvent, occurrence: BoardEventOccurrence) -> datetime:
    if not event.all_day:
        return datetime.fromisoformat(occurrence.start.replace("Z", "+00:00")).astimezone(UTC)
    start = _compatible_local_instant(
        date.fromisoformat(occurrence.start), time.min, ZoneInfo(event.timezone_name)
    )
    if start is None:
        raise ValueError("Event occurrence has no valid local start")
    return start


def reminder_due_at(start: datetime, timing: str) -> datetime:
    if timing not in OFFSETS:
        raise ValueError("Unsupported reminder timing")
    return start.astimezone(UTC) - OFFSETS[timing]


def _local_date(event: BoardEvent, instant: datetime) -> date:
    return instant.astimezone(ZoneInfo(event.timezone_name)).date()


def occurrence_at(event: BoardEvent, start: datetime) -> BoardEventOccurrence | None:
    """The occurrence of the event that starts at this instant, if it still exists."""

    try:
        day = _local_date(event, start)
        found = expand_board_event_occurrences(
            event, day - timedelta(days=1), day + timedelta(days=1)
        )
    except (OverflowError, ValueError):
        return None
    for occurrence in found.occurrences:
        try:
            if occurrence_instant(event, occurrence) == start.astimezone(UTC):
                return occurrence
        except ValueError:
            continue
    return None


def next_occurrence_start(event: BoardEvent, timing: str, after: datetime) -> datetime | None:
    """The start of the first occurrence whose reminder is due at or after ``after``."""

    offset = OFFSETS[timing]
    try:
        first = _local_date(event, after + offset) - timedelta(days=1)
    except (OverflowError, ValueError):
        return None
    for step in range(0, _SEARCH_LIMIT_DAYS, _SEARCH_STEP_DAYS):
        window_start = first + timedelta(days=step)
        window_end = window_start + timedelta(days=_SEARCH_STEP_DAYS - 1)
        found = expand_board_event_occurrences(event, window_start, window_end)
        for occurrence in found.occurrences:
            try:
                start = occurrence_instant(event, occurrence)
            except ValueError:
                continue
            if start - offset >= after:
                return start
    return None


def event_reminders(db: Session, event_id: UUID, *, lock: bool = False) -> list[BoardEventReminder]:
    statement = (
        select(BoardEventReminder)
        .where(BoardEventReminder.event_id == event_id, BoardEventReminder.is_deleted.is_(False))
        .order_by(BoardEventReminder.id)
    )
    if lock:
        statement = statement.with_for_update()
    return list(db.scalars(statement))


def timings_by_event(db: Session, event_ids: Iterable[UUID]) -> dict[UUID, list[str]]:
    ids = sorted(set(event_ids))
    found: dict[UUID, list[str]] = {event_id: [] for event_id in ids}
    if not ids:
        return found
    for event_id, timing in db.execute(
        select(BoardEventReminder.event_id, BoardEventReminder.timing).where(
            BoardEventReminder.event_id.in_(ids), BoardEventReminder.is_deleted.is_(False)
        )
    ):
        found[event_id].append(timing)
    return {event_id: ordered_timings(timings) for event_id, timings in found.items()}


def _delete_work(db: Session, reminder_ids: list[UUID], *, pending_only: bool) -> None:
    if not reminder_ids:
        return
    statement = select(ScheduledWork).where(
        ScheduledWork.kind == WorkKind.EVENT_REMINDER,
        ScheduledWork.reminder_id.in_(reminder_ids),
    )
    if pending_only:
        statement = statement.where(ScheduledWork.state == WorkState.PENDING)
    rows = list(db.scalars(statement.order_by(ScheduledWork.id).with_for_update()))
    if not rows:
        return
    for notice in db.scalars(
        select(InAppNotification)
        .where(InAppNotification.work_id.in_([work.id for work in rows]))
        .order_by(InAppNotification.id)
        .with_for_update()
    ):
        db.delete(notice)
    db.flush()
    for work in rows:
        db.delete(work)
    db.flush()


def clear_pending_reminder_work(db: Session, event_id: UUID) -> None:
    """Delete queued occurrences after a time change or an archive; the worker queues again.

    Pending rows have no notifications yet. A deleted row frees its occurrence key,
    so an occurrence that keeps its start can be queued again.
    """

    _delete_work(db, [item.id for item in event_reminders(db, event_id)], pending_only=True)


def set_event_reminders(db: Session, event: BoardEvent, timings: Iterable[str]) -> None:
    """Make the event's reminders exactly these timings; the caller locked the event."""

    wanted = set(timings)
    removed: list[BoardEventReminder] = []
    for reminder in event_reminders(db, event.id, lock=True):
        if reminder.timing in wanted:
            wanted.discard(reminder.timing)
        else:
            removed.append(reminder)
    _delete_work(db, [item.id for item in removed], pending_only=False)
    for reminder in removed:
        db.delete(reminder)
    db.flush()
    for timing in ordered_timings(wanted):
        db.add(BoardEventReminder(board_id=event.board_id, event_id=event.id, timing=timing))
    db.flush()


def delete_event_reminders(db: Session, event_id: UUID) -> None:
    """Delete dependent notices, work and reminders before permanent event deletion."""

    reminders = event_reminders(db, event_id, lock=True)
    _delete_work(db, [item.id for item in reminders], pending_only=False)
    for reminder in reminders:
        db.delete(reminder)
    db.flush()
