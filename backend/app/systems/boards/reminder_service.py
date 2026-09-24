"""Personal Event occurrence validation, queueing, and pending-work reconciliation."""

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_occurrences import (
    BoardEventOccurrence,
    _compatible_local_instant,
    expand_board_event_occurrences,
)
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)

_OFFSETS = {"start": timedelta(), "15m": timedelta(minutes=15), "1d": timedelta(days=1)}


@dataclass(frozen=True, slots=True)
class EventTiming:
    """The fields needed to identify an occurrence before a series edit."""

    id: UUID
    all_day: bool
    start_date: date | None
    end_date: date | None
    start_at: datetime | None
    end_at: datetime | None
    timezone_name: str
    recurrence: str
    repeat_until: date | None


def snapshot_event_timing(event: BoardEvent) -> EventTiming:
    return EventTiming(
        id=event.id,
        all_day=event.all_day,
        start_date=event.start_date,
        end_date=event.end_date,
        start_at=event.start_at,
        end_at=event.end_at,
        timezone_name=event.timezone_name,
        recurrence=event.recurrence,
        repeat_until=event.repeat_until,
    )


def _anchor_date(event: EventTiming | BoardEvent) -> date | None:
    if event.all_day:
        return event.start_date
    if event.start_at is None:
        return None
    try:
        return event.start_at.astimezone(ZoneInfo(event.timezone_name)).date()
    except (TypeError, ValueError, OverflowError):
        return None


def _month(ordinal: int) -> tuple[int, int]:
    return ordinal // 12, ordinal % 12 + 1


def _monthly_date(anchor: date, index: int) -> date | None:
    from calendar import monthrange

    month = anchor.year * 12 + anchor.month - 1
    found = -1
    while month <= 9999 * 12 - 1:
        year, month_number = _month(month)
        if anchor.day <= monthrange(year, month_number)[1]:
            found += 1
            if found == index:
                return date(year, month_number, anchor.day)
        month += 1
    return None


def _occurrence_index(event: EventTiming, occurrence: date) -> int | None:
    anchor = _anchor_date(event)
    if anchor is None or occurrence < anchor:
        return None
    if event.recurrence == "none":
        return 0 if occurrence == anchor else None
    if event.recurrence in ("daily", "weekly"):
        step = 1 if event.recurrence == "daily" else 7
        elapsed = (occurrence - anchor).days
        return elapsed // step if elapsed % step == 0 else None
    if event.recurrence == "monthly":
        from calendar import monthrange

        if occurrence.day != anchor.day:
            return None
        index = 0
        first_month = anchor.year * 12 + anchor.month - 1
        final_month = occurrence.year * 12 + occurrence.month - 1
        for month in range(first_month, final_month + 1):
            year, month_number = _month(month)
            if anchor.day > monthrange(year, month_number)[1]:
                continue
            if month == final_month:
                return index
            index += 1
    return None


def _date_at_index(event: BoardEvent, index: int) -> date | None:
    anchor = _anchor_date(event)
    if anchor is None:
        return None
    try:
        if event.recurrence == "none":
            return anchor if index == 0 else None
        if event.recurrence == "daily":
            return anchor + timedelta(days=index)
        if event.recurrence == "weekly":
            return anchor + timedelta(days=index * 7)
        if event.recurrence == "monthly":
            return _monthly_date(anchor, index)
    except (OverflowError, ValueError):
        return None
    return None


def _occurrence_date(occurrence_id: str, event_id: UUID) -> date | None:
    prefix = f"{event_id}:"
    if not occurrence_id.startswith(prefix):
        return None
    tail = occurrence_id[len(prefix) :]
    try:
        return date.fromisoformat(tail[:10])
    except ValueError:
        return None


def _one_occurrence(event: BoardEvent, day: date) -> BoardEventOccurrence | None:
    result = expand_board_event_occurrences(event, day, day)
    return next((item for item in result.occurrences if item.date == day.isoformat()), None)


def occurrence_for_id(event: BoardEvent, occurrence_id: str) -> BoardEventOccurrence | None:
    day = _occurrence_date(occurrence_id, event.id)
    if day is None:
        return None
    occurrence = _one_occurrence(event, day)
    return occurrence if occurrence is not None and occurrence.id == occurrence_id else None


def occurrence_instant(event: BoardEvent, occurrence: BoardEventOccurrence) -> datetime:
    if not event.all_day:
        return datetime.fromisoformat(occurrence.start.replace("Z", "+00:00")).astimezone(UTC)
    start = _compatible_local_instant(
        date.fromisoformat(occurrence.start), time.min, ZoneInfo(event.timezone_name)
    )
    if start is None:
        raise ValueError("Event occurrence has no valid local start")
    return start


def reminder_due_at(start: datetime, timing: str, *, now: datetime | None = None) -> datetime:
    if timing == "now":
        return (now or utc_now()).astimezone(UTC)
    if timing not in _OFFSETS:
        raise ValueError("Unsupported reminder timing")
    return start.astimezone(UTC) - _OFFSETS[timing]


def _cancel(work: ScheduledWork) -> None:
    work.state = WorkState.CANCELED
    work.failure_code = "occurrence_removed"
    work.lease_token = None
    work.lease_expires_at = None


def cancel_event_reminders(db: Session, event_id: UUID) -> None:
    """Cancel every pending reminder while the Event is locked by its caller."""

    for work in db.scalars(
        select(ScheduledWork)
        .join(BoardEventReminder, BoardEventReminder.id == ScheduledWork.reminder_id)
        .where(
            ScheduledWork.kind == WorkKind.EVENT_REMINDER,
            ScheduledWork.state == WorkState.PENDING,
            BoardEventReminder.event_id == event_id,
        )
        .order_by(ScheduledWork.id)
        .with_for_update(of=ScheduledWork)
    ):
        _cancel(work)


def delete_event_reminders(db: Session, event_id: UUID) -> None:
    """Delete dependent notices and work before permanent Event deletion."""

    reminders = list(
        db.scalars(
            select(BoardEventReminder)
            .where(BoardEventReminder.event_id == event_id)
            .order_by(BoardEventReminder.id)
            .with_for_update()
        )
    )
    for reminder in reminders:
        work = db.scalar(
            select(ScheduledWork).where(ScheduledWork.reminder_id == reminder.id).with_for_update()
        )
        if work is not None:
            for notice in db.scalars(
                select(InAppNotification)
                .where(InAppNotification.work_id == work.id)
                .order_by(InAppNotification.id)
                .with_for_update()
            ):
                db.delete(notice)
            db.flush()
            db.delete(work)
            db.flush()
        db.delete(reminder)
    db.flush()


def reconcile_event_reminders(db: Session, event: BoardEvent, previous: EventTiming) -> None:
    """Move pending occurrence work by recurrence ordinal, cancel removed instances."""

    reminders = list(
        db.scalars(
            select(BoardEventReminder)
            .where(BoardEventReminder.event_id == event.id)
            .order_by(BoardEventReminder.id)
            .with_for_update()
        )
    )
    occupied = {
        (reminder.recipient_id, reminder.occurrence_id): reminder.id for reminder in reminders
    }
    removed: list[BoardEventReminder] = []
    planned: dict[
        UUID,
        tuple[BoardEventReminder, ScheduledWork, BoardEventOccurrence, datetime, datetime],
    ] = {}
    for reminder in reminders:
        work = db.scalar(
            select(ScheduledWork)
            .where(
                ScheduledWork.reminder_id == reminder.id,
                ScheduledWork.kind == WorkKind.EVENT_REMINDER,
            )
            .with_for_update()
        )
        if work is None or work.state != WorkState.PENDING:
            continue
        old_day = _occurrence_date(reminder.occurrence_id, event.id)
        index = _occurrence_index(previous, old_day) if old_day is not None else None
        new_day = _date_at_index(event, index) if index is not None else None
        occurrence = _one_occurrence(event, new_day) if new_day is not None else None
        if occurrence is None or event.archived:
            _cancel(work)
            if occurrence is None:
                removed.append(reminder)
                occupied.pop((reminder.recipient_id, reminder.occurrence_id))
            continue
        start = occurrence_instant(event, occurrence)
        due = (
            reminder.due_at if reminder.timing == "now" else reminder_due_at(start, reminder.timing)
        )
        planned[reminder.id] = reminder, work, occurrence, start, due

    # Every destination occupied by another moving reminder becomes free only
    # after that row moves. A blocked move leaves its old ID occupied, so repeat
    # the collision check until those dependent moves have also been canceled.
    moving = {
        reminder_id
        for reminder_id, (reminder, _, occurrence, _, _) in planned.items()
        if reminder.occurrence_id != occurrence.id
    }
    while moving:
        blocked: set[UUID] = set()
        destinations: dict[tuple[UUID, str], UUID] = {}
        for reminder_id in sorted(moving):
            reminder, _, occurrence, _, _ = planned[reminder_id]
            destination = reminder.recipient_id, occurrence.id
            if destination in destinations:
                blocked.add(reminder_id)
                continue
            destinations[destination] = reminder_id
            holder = occupied.get(destination)
            if holder is not None and holder != reminder_id and holder not in moving:
                blocked.add(reminder_id)
        if not blocked:
            break
        for reminder_id in blocked:
            moving.remove(reminder_id)
            _cancel(planned[reminder_id][1])

    # Release removed and moving old IDs before assigning any destination;
    # the database checks uniqueness on each flush, not just the final mapping.
    for reminder in removed:
        reminder.occurrence_id = f"{event.id}:removed:{reminder.id}"
    for reminder_id in moving:
        planned[reminder_id][0].occurrence_id = f"{event.id}:moving:{reminder_id}"
    if removed or moving:
        db.flush()
    for reminder, work, occurrence, start, due in planned.values():
        if work.state != WorkState.PENDING:
            continue
        reminder.occurrence_id = occurrence.id
        reminder.occurrence_start_at = start
        reminder.due_at = due
        due_changed = work.scheduled_for != due
        work.scheduled_for = due
        if due_changed:
            work.next_attempt_at = due
