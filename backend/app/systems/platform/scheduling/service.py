"""Short, caller-committed transactions for durable scheduled Report work."""

from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import Select, and_, false, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.access.policy.checks import module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.models import User, UserStatus
from app.systems.boards.access import visible_board_clause
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardStatus
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.manage.audit.context import get_audit_context
from app.systems.openview.reports.models import Report, ReportRun, ReportRunEligibleUser
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)
from app.systems.sandbox.modules.models import Module

MAX_CLAIM_BATCH = 20
MAX_ATTEMPTS = 5
LEASE_DURATION = timedelta(minutes=2)
# The length of ``audit_logs.actor_label``.
ACTOR_LABEL_LENGTH = 100


@dataclass(frozen=True, slots=True)
class WorkClaim:
    id: UUID
    lease_token: UUID


def _utc_instant(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError("Scheduled work requires a UTC instant")
    return value


def report_source(db: Session, report: Report | None, *, lock: bool) -> Module | None:
    """Return the live module of an active Report, or None when it cannot run.

    A scheduled Report runs as the workspace, so no user decides whether it runs:
    it runs while the Report and its module are active.
    """

    if report is None or report.is_deleted or report.deleted_at is not None:
        return None
    module_query = select(Module).where(Module.id == report.module_id)
    if lock:
        module_query = module_query.with_for_update()
    module = db.scalar(module_query)
    if module is None or module.is_deleted or module.deleted_at is not None:
        return None
    return module


def scheduled_actor_label(report: Report) -> str:
    """The audit actor of a scheduled run: the workspace, named after the Report."""

    return f"Scheduled report: {report.name}"[:ACTOR_LABEL_LENGTH]


def queue_report_occurrence(
    db: Session, report_id: UUID, *, scheduled_for: datetime
) -> ScheduledWork:
    """Materialize one UTC occurrence; the caller owns commit and source scheduling."""

    instant = _utc_instant(scheduled_for)
    report = db.scalar(select(Report).where(Report.id == report_id).with_for_update())
    if report_source(db, report, lock=True) is None:
        raise ValueError("Report is unavailable for scheduling")
    existing = db.scalar(
        select(ScheduledWork).where(
            ScheduledWork.kind == WorkKind.REPORT_RUN,
            ScheduledWork.report_id == report_id,
            ScheduledWork.scheduled_for == instant,
        )
    )
    if existing is not None:
        return existing
    work = ScheduledWork(
        kind=WorkKind.REPORT_RUN,
        report_id=report_id,
        scheduled_for=instant,
        next_attempt_at=instant,
    )
    try:
        with db.begin_nested():
            db.add(work)
            db.flush()
    except IntegrityError:
        existing = db.scalar(
            select(ScheduledWork).where(
                ScheduledWork.kind == WorkKind.REPORT_RUN,
                ScheduledWork.report_id == report_id,
                ScheduledWork.scheduled_for == instant,
            )
        )
        if existing is None:
            raise
        return existing
    return work


def claim_due_work(
    db: Session, *, now: datetime | None = None, limit: int = MAX_CLAIM_BATCH
) -> list[WorkClaim]:
    """Lock due rows without waiting; expired leases become eligible again."""

    if not 1 <= limit <= MAX_CLAIM_BATCH:
        raise ValueError("Work claim limit is out of range")
    current = _utc_instant(now or utc_now())
    rows = list(
        db.scalars(
            select(ScheduledWork)
            .where(
                ScheduledWork.kind == WorkKind.REPORT_RUN,
                or_(
                    and_(
                        ScheduledWork.state == WorkState.PENDING,
                        ScheduledWork.next_attempt_at <= current,
                    ),
                    and_(
                        ScheduledWork.state == WorkState.RUNNING,
                        ScheduledWork.lease_expires_at <= current,
                    ),
                ),
            )
            .order_by(ScheduledWork.next_attempt_at, ScheduledWork.id)
            .limit(limit)
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True)
        )
    )
    claims: list[WorkClaim] = []
    for work in rows:
        if work.attempt_count >= MAX_ATTEMPTS:
            work.state = WorkState.FAILED
            work.failure_code = "attempts_exhausted"
            work.lease_token = None
            work.lease_expires_at = None
            continue
        work.state = WorkState.RUNNING
        work.attempt_count += 1
        work.lease_token = uuid7()
        work.lease_expires_at = current + LEASE_DURATION
        claims.append(WorkClaim(work.id, work.lease_token))
    return claims


def _locked_claim(db: Session, claim: WorkClaim, now: datetime) -> ScheduledWork | None:
    return db.scalar(
        select(ScheduledWork)
        .where(
            ScheduledWork.id == claim.id,
            ScheduledWork.kind == WorkKind.REPORT_RUN,
            ScheduledWork.state == WorkState.RUNNING,
            ScheduledWork.lease_token == claim.lease_token,
            ScheduledWork.lease_expires_at > now,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def complete_report_work(
    db: Session, claim: WorkClaim, run_id: UUID, *, now: datetime | None = None
) -> bool:
    """Finalize the current lease and notify every module reader recorded on the run."""

    current = _utc_instant(now or utc_now())
    report_id = db.scalar(
        select(ScheduledWork.report_id).where(
            ScheduledWork.id == claim.id, ScheduledWork.kind == WorkKind.REPORT_RUN
        )
    )
    if report_id is None:
        return False
    # Match Report lifecycle order: source and its policy rows precede the work row.
    report = db.scalar(select(Report).where(Report.id == report_id).with_for_update())
    source = report_source(db, report, lock=True)
    work = _locked_claim(db, claim, current)
    if work is None or work.report_id != report_id:
        return False
    if report is None or source is None:
        work.state = WorkState.CANCELED
        work.failure_code = "source_unavailable"
        work.lease_token = None
        work.lease_expires_at = None
        return False
    run = db.scalar(select(ReportRun).where(ReportRun.id == run_id))
    if (
        run is None
        or run.report_id != work.report_id
        or run.module_id != report.module_id
        or run.idempotency_key != work.id
    ):
        raise ValueError("Report run does not match the scheduled occurrence")
    work.state = WorkState.SUCCEEDED
    work.run_id = run.id
    work.failure_code = None
    work.lease_token = None
    work.lease_expires_at = None
    context = get_audit_context(db)
    if context.request_method is None:
        context.request_id = uuid7()
        context.request_method = "SCHEDULE"
        context.request_path = "/internal/reports/scheduler"
    context.performed_by = None
    context.actor_label = scheduled_actor_label(report)
    for recipient_id in db.scalars(
        select(ReportRunEligibleUser.user_id).where(ReportRunEligibleUser.run_id == run.id)
    ):
        db.add(InAppNotification(work_id=work.id, recipient_id=recipient_id))
    return True


def fail_report_work(db: Session, claim: WorkClaim, *, now: datetime | None = None) -> bool:
    """Release a failed lease with bounded backoff or terminal exhaustion."""

    current = _utc_instant(now or utc_now())
    work = _locked_claim(db, claim, current)
    if work is None:
        return False
    if work.attempt_count >= MAX_ATTEMPTS:
        work.state = WorkState.FAILED
        work.failure_code = "attempts_exhausted"
    else:
        work.state = WorkState.PENDING
        work.next_attempt_at = current + timedelta(seconds=min(2**work.attempt_count, 300))
        work.failure_code = "run_failed"
    work.lease_token = None
    work.lease_expires_at = None
    return True


def current_user_notification_query(db: Session, user_id: UUID) -> Select[tuple[InAppNotification]]:
    """Apply current source, Board and content policy before notification paging."""

    user = db.scalar(
        select(User)
        .where(User.id == user_id)
        .with_for_update(of=User)
        .execution_options(populate_existing=True)
    )
    if (
        user is None
        or user.is_deleted
        or user.deleted_at is not None
        or user.status != UserStatus.ACTIVE.value
        or not is_established_user(user)
    ):
        return select(InAppNotification).where(false())
    report_ids = (
        select(InAppNotification.id)
        .join(ScheduledWork, ScheduledWork.id == InAppNotification.work_id)
        .join(Report, Report.id == ScheduledWork.report_id)
        .join(ReportRun, ReportRun.id == ScheduledWork.run_id)
        .join(ReportRunEligibleUser, ReportRunEligibleUser.run_id == ScheduledWork.run_id)
        .join(Module, Module.id == Report.module_id)
        .where(
            InAppNotification.recipient_id == user_id,
            ReportRunEligibleUser.user_id == user_id,
            InAppNotification.is_deleted.is_(False),
            ScheduledWork.state == WorkState.SUCCEEDED,
            ScheduledWork.kind == WorkKind.REPORT_RUN,
            ReportRun.report_id == Report.id,
            ReportRun.is_deleted.is_(False),
            module_filter(db, user, AccessLevel.READ, Report.module_id),
            Report.is_deleted.is_(False),
            Report.deleted_at.is_(None),
            Module.is_deleted.is_(False),
            Module.deleted_at.is_(None),
        )
    )
    reminder_ids = (
        select(InAppNotification.id)
        .join(ScheduledWork, ScheduledWork.id == InAppNotification.work_id)
        .join(BoardEventReminder, BoardEventReminder.id == ScheduledWork.reminder_id)
        .join(BoardEvent, BoardEvent.id == BoardEventReminder.event_id)
        .join(Board, Board.id == BoardEventReminder.board_id)
        .where(
            InAppNotification.recipient_id == user_id,
            InAppNotification.is_deleted.is_(False),
            ScheduledWork.kind == WorkKind.EVENT_REMINDER,
            ScheduledWork.state == WorkState.SUCCEEDED,
            BoardEventReminder.is_deleted.is_(False),
            BoardEventReminder.deleted_at.is_(None),
            BoardEvent.board_id == Board.id,
            BoardEvent.is_deleted.is_(False),
            BoardEvent.deleted_at.is_(None),
            BoardEvent.archived.is_(False),
            Board.is_deleted.is_(False),
            Board.deleted_at.is_(None),
            Board.status == BoardStatus.ACTIVE,
            visible_board_clause(user),
        )
    )
    post_ids = (
        select(InAppNotification.id)
        .join(ScheduledWork, ScheduledWork.id == InAppNotification.work_id)
        .join(BoardPost, BoardPost.id == ScheduledWork.post_id)
        .join(
            BoardPostRevision,
            BoardPostRevision.id == ScheduledWork.publication_result_id,
        )
        .join(Board, Board.id == BoardPost.board_id)
        .where(
            InAppNotification.recipient_id == user_id,
            InAppNotification.is_deleted.is_(False),
            ScheduledWork.kind == WorkKind.POST_PUBLISH,
            ScheduledWork.state == WorkState.SUCCEEDED,
            BoardPost.is_deleted.is_(False),
            BoardPost.deleted_at.is_(None),
            BoardPost.status == "published",
            BoardPost.displayed_publication_number
            == BoardPostRevision.publication_number,
            BoardPostRevision.post_id == BoardPost.id,
            BoardPostRevision.is_deleted.is_(False),
            BoardPostRevision.deleted_at.is_(None),
            Board.is_deleted.is_(False),
            Board.deleted_at.is_(None),
            Board.status == BoardStatus.ACTIVE,
            visible_board_clause(user),
            or_(
                BoardPostRevision.expires_at.is_(None),
                BoardPostRevision.expires_at > utc_now(),
            ),
        )
    )

    return select(InAppNotification).where(
        or_(
            InAppNotification.id.in_(report_ids),
            InAppNotification.id.in_(reminder_ids),
            InAppNotification.id.in_(post_ids),
        )
    )


def list_current_user_notifications(
    db: Session, user_id: UUID, *, limit: int = 50, offset: int = 0
) -> list[InAppNotification]:
    """Return references only while the recipient can still read the source."""

    if not 1 <= limit <= 100 or offset < 0:
        raise ValueError("Notification page is out of range")
    return list(
        db.scalars(
            current_user_notification_query(db, user_id)
            .order_by(InAppNotification.created_at.desc(), InAppNotification.id.desc())
            .limit(limit)
            .offset(offset)
        )
    )
