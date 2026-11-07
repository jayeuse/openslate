"""Bounded retention sweep of finished trigger history, notifications and old runs (D3).

The sweep runs on the scheduling thread, one organization at a time, and each batch is its
own commit. Every delete is an individual ORM delete, so audited models keep their whole
history. A batch stays below ``MAX_INVALIDATIONS_PER_COMMIT``: more public invalidations in
one commit become a resync for every open browser, and more private ones are dropped.

Before each batch the sweep yields to a burst: a trigger event that has waited stops the
wake, so the sweep adds no commits while the trigger lanes catch up.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import Engine, exists, func, select
from sqlalchemy.orm import Session, aliased, load_only
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.organization_scope import session_organization
from app.core.database.session import AuditSession
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.openview.reports.deletion_service import delete_report_run
from app.systems.openview.reports.models import Report, ReportRun
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork
from app.systems.sandbox.record_triggers.models import (
    RecordTriggerEvent,
    RecordTriggerRun,
    TriggerEventState,
)
from app.systems.sandbox.test_runs.models import SandboxTestRun

READ_NOTIFICATION_AGE = timedelta(days=30)
UNREAD_NOTIFICATION_AGE = timedelta(days=90)
REPORT_RUN_AGE = timedelta(days=30)
REPORT_RUNS_KEPT = 30
TEST_RUNS_KEPT = 20
AUDITED_BATCH = 50
EVENT_BATCH = 500
BATCHES_PER_WAKE = 40
# A run's output rows cost as much as this many batches, so a wake stays short on this thread.
REPORT_ROWS_PER_BATCH = 500
BACKLOG_GRACE = timedelta(seconds=1)
_LOCK_NAME = "slateops:retention"
# An event's last attempt time is close to its finish time, and the due index holds it.
_FINISHED_EVENT_AGES = (
    (TriggerEventState.SUCCEEDED, timedelta(days=30)),
    (TriggerEventState.FAILED, timedelta(days=90)),
)


def _session(engine: Engine) -> AuditSession:
    db = AuditSession(engine)
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        request_id=uuid7(),
        request_method="RETENTION",
        request_path="/internal/scheduling/retention",
        actor_label="Scheduled retention",
    )
    return db


def trim_trigger_runs(db: Session, now: datetime) -> int:
    """Delete one batch of runs whose event is finished and old enough."""

    for state, age in _FINISHED_EVENT_AGES:
        runs = list(
            db.scalars(
                select(RecordTriggerRun)
                .join(RecordTriggerEvent, RecordTriggerEvent.id == RecordTriggerRun.event_id)
                .where(
                    RecordTriggerEvent.state == state,
                    RecordTriggerEvent.next_attempt_at < now - age,
                )
                .order_by(RecordTriggerEvent.next_attempt_at, RecordTriggerEvent.id)
                .limit(AUDITED_BATCH)
                .with_for_update(of=RecordTriggerRun, skip_locked=True)
            )
        )
        if runs:
            for run in runs:
                db.delete(run)
            db.flush()
            return 1
    return 0


def trim_trigger_events(db: Session, now: datetime) -> int:
    """Delete finished, old events that no run or child references; a root goes after them.

    A child row points to its root until it goes itself, so this also keeps the root of an
    unfinished chain. Events are outside audit, and only their id is read.
    """

    child = aliased(RecordTriggerEvent)
    for state, age in _FINISHED_EVENT_AGES:
        events = list(
            db.scalars(
                select(RecordTriggerEvent)
                .options(load_only(RecordTriggerEvent.id))
                .where(
                    RecordTriggerEvent.state == state,
                    RecordTriggerEvent.next_attempt_at < now - age,
                    ~exists().where(RecordTriggerRun.event_id == RecordTriggerEvent.id),
                    ~exists().where(child.root_event_id == RecordTriggerEvent.id),
                )
                .order_by(RecordTriggerEvent.next_attempt_at, RecordTriggerEvent.id)
                .limit(EVENT_BATCH)
                .with_for_update(of=RecordTriggerEvent, skip_locked=True)
            )
        )
        if events:
            for event in events:
                db.delete(event)
            db.flush()
            return 1
    return 0


def _uuid7_floor(moment: datetime) -> UUID:
    """The lowest UUIDv7 of ``moment``: its millisecond in the top 48 bits, then zeros."""

    return UUID(int=int(moment.timestamp() * 1000) << 80)


def trim_notifications(db: Session, now: datetime) -> int:
    """Delete one batch of old notifications; a soft-deleted one ages the same way.

    Ids are UUIDv7, so the id bound reads only rows old enough on the primary key: with no
    such row the read touches 2 pages, where the age filter alone reads the whole
    organization's notifications. ``created_at`` stays the rule; the bound only prunes.
    """

    for unread, age in ((True, UNREAD_NOTIFICATION_AGE), (False, READ_NOTIFICATION_AGE)):
        cutoff = now - age
        notifications = list(
            db.scalars(
                select(InAppNotification)
                .where(
                    InAppNotification.id < _uuid7_floor(cutoff),
                    InAppNotification.created_at < cutoff,
                    InAppNotification.read_at.is_(None)
                    if unread
                    else InAppNotification.read_at.is_not(None),
                )
                .limit(AUDITED_BATCH)
                .with_for_update(skip_locked=True)
            )
        )
        if notifications:
            for notification in notifications:
                db.delete(notification)
            db.flush()
            return 1
    return 0


def trim_report_run(db: Session, now: datetime) -> int:
    """Delete one run past a report's latest 30 and older than 30 days, under the report's lock.

    Any module reader can post a run, so the age keeps a burst from removing recent history.
    A run can have more recipients than one batch holds, so its notifications go first in
    their own commits; the run then goes in one transaction.
    """

    position = func.row_number().over(
        partition_by=ReportRun.report_id,
        order_by=(ReportRun.created_at.desc(), ReportRun.id.desc()),
    )
    ranked = select(
        ReportRun.id, ReportRun.report_id, ReportRun.created_at, position.label("position")
    ).subquery()
    excess = db.execute(
        select(ranked.c.id, ranked.c.report_id)
        .where(
            ranked.c.position > REPORT_RUNS_KEPT,
            ranked.c.created_at < now - REPORT_RUN_AGE,
        )
        .limit(1)
    ).first()
    if excess is None:
        return 0
    report = db.scalar(
        select(Report).where(Report.id == excess.report_id).with_for_update(skip_locked=True)
    )
    if report is None:
        return 0
    notifications = list(
        db.scalars(
            select(InAppNotification)
            .join(ScheduledWork, ScheduledWork.id == InAppNotification.work_id)
            .where(ScheduledWork.run_id == excess.id)
            .order_by(InAppNotification.id)
            .limit(AUDITED_BATCH)
            .with_for_update(of=InAppNotification)
        )
    )
    if len(notifications) == AUDITED_BATCH:
        for notification in notifications:
            db.delete(notification)
        db.flush()
        return 1
    run = db.scalar(select(ReportRun).where(ReportRun.id == excess.id).with_for_update())
    if run is None:
        return 0
    delete_report_run(db, run)
    return 1 + run.row_count // REPORT_ROWS_PER_BATCH


def trim_test_runs(db: Session, _now: datetime) -> int:
    """Delete one batch past a document's latest 20 live runs; cleared runs always go."""

    position = func.row_number().over(
        partition_by=SandboxTestRun.document_id,
        order_by=(SandboxTestRun.created_at.desc(), SandboxTestRun.id.desc()),
    )
    ranked = (
        select(SandboxTestRun.id, position.label("position"))
        .where(SandboxTestRun.is_deleted.is_(False))
        .subquery()
    )
    kept = select(ranked.c.id).where(ranked.c.position <= TEST_RUNS_KEPT)
    runs = list(
        db.scalars(
            select(SandboxTestRun)
            .where(SandboxTestRun.id.not_in(kept))
            .order_by(SandboxTestRun.id)
            .limit(AUDITED_BATCH)
            .with_for_update(skip_locked=True)
        )
    )
    if not runs:
        return 0
    for run in runs:
        db.delete(run)
    db.flush()
    return 1


_STAGES: tuple[Callable[[Session, datetime], int], ...] = (
    trim_trigger_runs,
    trim_trigger_events,
    trim_notifications,
    trim_report_run,
    trim_test_runs,
)


def _clear_to_sweep(db: Session, now: datetime) -> bool:
    """Each API process runs this thread; only one of them runs a batch of an organization.

    The lock lasts for one batch, so processes can take turns inside a wake. A process that
    misses the lock ends its wake for this organization.
    """

    name = f"{_LOCK_NAME}:{session_organization(db)}"
    if not db.scalar(select(func.pg_try_advisory_xact_lock(func.hashtextextended(name, 0)))):
        return False
    due = db.scalar(
        select(RecordTriggerEvent.id)
        .where(
            RecordTriggerEvent.state == TriggerEventState.PENDING,
            RecordTriggerEvent.next_attempt_at < now - BACKLOG_GRACE,
        )
        .order_by(RecordTriggerEvent.next_attempt_at, RecordTriggerEvent.id)
        .limit(1)
    )
    return due is None


def _run_batch(
    engine: Engine, stage: Callable[[Session, datetime], int], now: datetime | None
) -> int | None:
    """Commit one batch and return its cost; None stops the wake."""

    current = now or utc_now()
    with _session(engine) as db:
        if not _clear_to_sweep(db, current):
            db.rollback()
            return None
        cost = stage(db, current)
        db.commit()
        return cost


def sweep_organization(
    engine: Engine,
    *,
    now: datetime | None = None,
    stopping: Callable[[], bool] = lambda: False,
) -> None:
    """Sweep the bound organization until it is done or the wake's batches run out."""

    left = BATCHES_PER_WAKE
    for stage in _STAGES:
        while left > 0 and not stopping():
            cost = _run_batch(engine, stage, now)
            if cost is None:
                return
            if cost == 0:
                break
            left -= cost
