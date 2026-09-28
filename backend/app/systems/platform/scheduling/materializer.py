"""Persisted Report schedule occurrence calculation and materialization."""

from datetime import UTC, datetime, time, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.openview.reports.models import Report
from app.systems.openview.reports.schedule_models import ReportSchedule
from app.systems.platform.scheduling.service import queue_report_occurrence


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
