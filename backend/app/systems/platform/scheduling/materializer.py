"""Report schedule occurrences and the next occurrence of each event reminder."""

from datetime import UTC, datetime, time, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardStatus
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.boards.reminder_service import (
    REMINDER_DELIVERY_GRACE,
    next_occurrence_start,
    reminder_due_at,
)
from app.systems.openview.reports.models import Report
from app.systems.openview.reports.schedule_models import ReportSchedule
from app.systems.platform.scheduling.models import ScheduledWork, WorkKind, WorkState
from app.systems.platform.scheduling.service import queue_report_occurrence

MAX_REMINDER_BATCH = 100


def next_due_after(
    *,
    cadence: str,
    timezone_name: str,
    local_time: time,
    weekday: int | None,
    month_day: int | None,
    after: datetime,
) -> datetime:
    """Return the next logical wall-clock occurrence strictly after a UTC instant."""

    if after.tzinfo is None or after.utcoffset() != timedelta(0):
        raise ValueError("Schedule cursor requires a UTC instant")
    if local_time.tzinfo is not None or local_time.second or local_time.microsecond:
        raise ValueError("Schedule time requires a local hour and minute")
    if not (
        (cadence == "daily" and weekday is None and month_day is None)
        or (cadence == "weekly" and weekday in range(7) and month_day is None)
        or (cadence == "monthly" and weekday is None and month_day in range(1, 32))
    ):
        raise ValueError("Schedule cadence and anchor do not match")
    try:
        zone = ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        raise ValueError("Schedule requires an IANA timezone") from None

    start = after.astimezone(zone).date()
    for offset in range(370):
        day = start + timedelta(days=offset)
        if cadence == "weekly" and day.weekday() != weekday:
            continue
        if cadence == "monthly" and day.day != month_day:
            continue
        wall = datetime.combine(day, local_time).replace(tzinfo=zone, fold=0)
        # fold=0 chooses the earlier offset when the wall time repeats. During
        # a gap, the UTC round-trip shifts the imaginary time forward by it.
        instant = wall.astimezone(UTC)
        if instant > after:
            return instant
    raise ValueError("Schedule has no occurrence in the next year")


def materialize_due_schedules(
    db: Session, *, now: datetime | None = None, limit: int = 20
) -> list[UUID]:
    """Enqueue one occurrence per due policy; the caller owns commit or rollback.

    Candidate discovery does not lock policy rows. For each candidate we lock
    Report before ReportSchedule, then recheck revision and due state. This
    matches Report deletion and queue completion lock order.
    """

    if not 1 <= limit <= 20:
        raise ValueError("Materialization batch limit is out of range")
    current = now or utc_now()
    if current.tzinfo is None or current.utcoffset() != timedelta(0):
        raise ValueError("Materialization requires a UTC instant")
    candidates = db.execute(
        select(ReportSchedule.id, ReportSchedule.report_id, ReportSchedule.revision)
        .where(
            ReportSchedule.enabled.is_(True),
            ReportSchedule.is_deleted.is_(False),
            ReportSchedule.deleted_at.is_(None),
            ReportSchedule.next_due_at <= current,
        )
        .order_by(ReportSchedule.next_due_at, ReportSchedule.id)
        .limit(limit)
    ).all()
    work_ids: list[UUID] = []
    for schedule_id, report_id, revision in candidates:
        report = db.scalar(
            select(Report)
            .where(Report.id == report_id)
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True)
        )
        if report is None:
            continue
        schedule = db.scalar(
            select(ReportSchedule)
            .where(ReportSchedule.id == schedule_id)
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True)
        )
        if (
            schedule is None
            or schedule.report_id != report.id
            or schedule.revision != revision
            or not schedule.enabled
            or schedule.is_deleted
            or schedule.deleted_at is not None
            or schedule.next_due_at > current
        ):
            continue
        try:
            following = next_due_after(
                cadence=schedule.cadence,
                timezone_name=schedule.timezone_name,
                local_time=schedule.local_time,
                weekday=schedule.weekday,
                month_day=schedule.month_day,
                after=schedule.next_due_at,
            )
            work = queue_report_occurrence(db, report.id, scheduled_for=schedule.next_due_at)
        except ValueError:
            # An archived Report, an inactive source module, or a corrupt policy
            # must not hot-loop at the head of the due queue.
            schedule.enabled = False
            schedule.revision += 1
            continue
        schedule.next_due_at = following
        work_ids.append(work.id)
    return work_ids


def materialize_event_reminders(
    db: Session, *, now: datetime | None = None, limit: int = MAX_REMINDER_BATCH
) -> list[UUID]:
    """Queue the next eligible occurrence of each live reminder.

    One ``scheduled_work`` row exists for each reminder and occurrence. A reminder
    due up to 15 minutes ago may still be queued for delivery. Older due times are
    skipped. The caller owns commit or rollback.
    """

    if not 1 <= limit <= MAX_REMINDER_BATCH:
        raise ValueError("Reminder materialization batch limit is out of range")
    current = now or utc_now()
    if current.tzinfo is None or current.utcoffset() != timedelta(0):
        raise ValueError("Materialization requires a UTC instant")
    earliest_due = current - REMINDER_DELIVERY_GRACE
    earliest_day = earliest_due.date() - timedelta(days=2)
    queued = exists(
        select(ScheduledWork.id).where(
            ScheduledWork.reminder_id == BoardEventReminder.id,
            ScheduledWork.state.in_((WorkState.PENDING, WorkState.RUNNING)),
        )
    )
    candidate_query = (
        select(BoardEventReminder.id, BoardEventReminder.timing, BoardEvent)
        .join(BoardEvent, BoardEvent.id == BoardEventReminder.event_id)
        .join(Board, Board.id == BoardEventReminder.board_id)
        .where(
            BoardEventReminder.is_deleted.is_(False),
            BoardEvent.is_deleted.is_(False),
            BoardEvent.deleted_at.is_(None),
            BoardEvent.archived.is_(False),
            Board.is_deleted.is_(False),
            Board.status == BoardStatus.ACTIVE,
            ~queued,
            or_(
                and_(BoardEvent.recurrence != "none", BoardEvent.repeat_until >= earliest_day),
                BoardEvent.start_at >= earliest_due,
                BoardEvent.start_date >= earliest_day,
            ),
        )
    )
    upper_id = db.scalar(
        select(BoardEventReminder.id).order_by(BoardEventReminder.id.desc()).limit(1)
    )
    if upper_id is None:
        return []
    work_ids: list[UUID] = []
    last_reminder_id: UUID | None = None
    while len(work_ids) < limit:
        page = candidate_query.where(BoardEventReminder.id <= upper_id)
        if last_reminder_id is not None:
            page = page.where(BoardEventReminder.id > last_reminder_id)
        candidates = db.execute(
            page.order_by(BoardEventReminder.id).limit(MAX_REMINDER_BATCH)
        ).all()
        if not candidates:
            break
        for reminder_id, timing, event in candidates:
            last_reminder_id = reminder_id
            cursor = earliest_due
            while (start := next_occurrence_start(event, timing, cursor)) is not None:
                due = reminder_due_at(start, timing)
                existing_state = db.scalar(
                    select(ScheduledWork.state).where(
                        ScheduledWork.reminder_id == reminder_id,
                        ScheduledWork.occurrence_start_at == start,
                    )
                )
                if existing_state in (WorkState.PENDING, WorkState.RUNNING):
                    break
                if existing_state is not None:
                    cursor = due + timedelta(microseconds=1)
                    continue
                work = ScheduledWork(
                    org_id=event.org_id,
                    kind=WorkKind.EVENT_REMINDER,
                    reminder_id=reminder_id,
                    occurrence_start_at=start,
                    scheduled_for=due,
                    next_attempt_at=due,
                )
                try:
                    with db.begin_nested():
                        db.add(work)
                        db.flush()
                except IntegrityError:
                    # Another worker won this occurrence key; its work will be polled.
                    break
                work_ids.append(work.id)
                break
            if len(work_ids) == limit:
                break
    return work_ids
