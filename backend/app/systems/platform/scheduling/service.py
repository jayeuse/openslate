"""Short, caller-committed transactions for durable scheduled Report work."""

from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import Select, and_, false, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.access.identity.eligibility import is_identity_eligible
from app.systems.access.policy.checks import module_filter, module_level
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.boards.announcement_models import (
    BoardAnnouncement,
    BoardAnnouncementRevision,
)
from app.systems.boards.announcement_service import audience_clause as announcement_audience_clause
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import _audience_clause as event_audience_clause
from app.systems.boards.models import Board, BoardStatus
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.boards.router import _board_view_clause
from app.systems.manage.audit.context import get_audit_context
from app.systems.openview.reports.audience import run_audience_clause
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


@dataclass(frozen=True, slots=True)
class WorkClaim:
    id: UUID
    lease_token: UUID


def _utc_instant(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError("Scheduled work requires a UTC instant")
    return value


def _eligible_owner(db: Session, report: Report, *, lock: bool) -> User | None:
    if report.is_deleted or report.deleted_at is not None:
        return None
    module_query = select(Module).where(Module.id == report.module_id)
    if lock:
        module_query = module_query.with_for_update()
    module = db.scalar(module_query)
    if (
        module is None
        or module.is_deleted
        or module.deleted_at is not None
    ):
        return None
    user_query = select(User).where(User.id == report.owner_id)
    if lock:
        user_query = user_query.with_for_update()
    user = db.scalar(user_query)
    if (
        user is None
        or user.is_deleted
        or user.deleted_at is not None
        or not is_identity_eligible(user)
        or user.status != UserStatus.ACTIVE.value
        or not is_established_user(user)
    ):
        return None
    # A scheduled report runs for an owner who is not a guest and can read its module.
    if user.role == UserRole.GUEST.value or module_level(db, user, module.id) is None:
        return None
    return user


def queue_report_occurrence(
    db: Session, report_id: UUID, *, scheduled_for: datetime
) -> ScheduledWork:
    """Materialize one UTC occurrence; the caller owns commit and source scheduling."""

    instant = _utc_instant(scheduled_for)
    report = db.scalar(select(Report).where(Report.id == report_id).with_for_update())
    if report is None or _eligible_owner(db, report, lock=True) is None:
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
    """Finalize the current lease without requiring the owner in the audience."""

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
    owner = _eligible_owner(db, report, lock=True) if report is not None else None
    work = _locked_claim(db, claim, current)
    if work is None or work.report_id != report_id:
        return False
    if report is None or owner is None:
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
            run_audience_clause(user),
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
            BoardEventReminder.recipient_id == user_id,
            BoardEventReminder.is_deleted.is_(False),
            BoardEventReminder.deleted_at.is_(None),
            BoardEvent.board_id == Board.id,
            BoardEvent.is_deleted.is_(False),
            BoardEvent.deleted_at.is_(None),
            BoardEvent.archived.is_(False),
            Board.is_deleted.is_(False),
            Board.deleted_at.is_(None),
            Board.status == BoardStatus.ACTIVE,
            _board_view_clause(user),
            event_audience_clause(user),
        )
    )
    announcement_ids = (
        select(InAppNotification.id)
        .join(ScheduledWork, ScheduledWork.id == InAppNotification.work_id)
        .join(BoardAnnouncement, BoardAnnouncement.id == ScheduledWork.announcement_id)
        .join(
            BoardAnnouncementRevision,
            BoardAnnouncementRevision.id == ScheduledWork.publication_result_id,
        )
        .join(Board, Board.id == BoardAnnouncement.board_id)
        .where(
            InAppNotification.recipient_id == user_id,
            InAppNotification.is_deleted.is_(False),
            ScheduledWork.kind == WorkKind.ANNOUNCEMENT_PUBLISH,
            ScheduledWork.state == WorkState.SUCCEEDED,
            BoardAnnouncement.is_deleted.is_(False),
            BoardAnnouncement.deleted_at.is_(None),
            BoardAnnouncement.status == "published",
            BoardAnnouncement.displayed_publication_number
            == BoardAnnouncementRevision.publication_number,
            BoardAnnouncementRevision.announcement_id == BoardAnnouncement.id,
            BoardAnnouncementRevision.is_deleted.is_(False),
            BoardAnnouncementRevision.deleted_at.is_(None),
            Board.is_deleted.is_(False),
            Board.deleted_at.is_(None),
            Board.status == BoardStatus.ACTIVE,
            _board_view_clause(user),
            or_(
                BoardAnnouncementRevision.expires_at.is_(None),
                BoardAnnouncementRevision.expires_at > utc_now(),
            ),
            announcement_audience_clause(BoardAnnouncementRevision, user),
        )
    )

    return select(InAppNotification).where(
        or_(
            InAppNotification.id.in_(report_ids),
            InAppNotification.id.in_(reminder_ids),
            InAppNotification.id.in_(announcement_ids),
        )
    )


def list_current_user_notifications(
    db: Session, user_id: UUID, *, limit: int = 50, offset: int = 0
) -> list[InAppNotification]:
    """Return references only for a currently eligible Report owner."""

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
