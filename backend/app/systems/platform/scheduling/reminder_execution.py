"""Once-only personal Event reminder delivery with current Board/content checks."""

import logging
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import Engine, and_, or_, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.session import AuditSession
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.models import User, UserStatus
from app.systems.boards.access import can_access_board
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import _audience_clause
from app.systems.boards.models import Board, BoardGrant, BoardPermission, BoardStatus
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.boards.reminder_service import occurrence_for_id, occurrence_instant
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)
from app.systems.platform.scheduling.service import (
    LEASE_DURATION,
    MAX_ATTEMPTS,
    MAX_CLAIM_BATCH,
    WorkClaim,
    _utc_instant,
)

logger = logging.getLogger(__name__)


def _current(now: datetime | None) -> datetime:
    return _utc_instant(now or utc_now())


def _session(engine: Engine) -> AuditSession:
    db = AuditSession(engine)
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        request_id=uuid7(),
        request_method="SCHEDULE",
        request_path="/internal/boards/event-reminders",
    )
    return db


def claim_due_reminder_work(
    db: Session, *, now: datetime | None = None, limit: int = MAX_CLAIM_BATCH
) -> list[WorkClaim]:
    """Claim only due reminder rows; expired leases may be recovered."""

    if not 1 <= limit <= MAX_CLAIM_BATCH:
        raise ValueError("Reminder claim limit is out of range")
    current = _current(now)
    works = list(
        db.scalars(
            select(ScheduledWork)
            .where(
                ScheduledWork.kind == WorkKind.EVENT_REMINDER,
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
    for work in works:
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
            ScheduledWork.kind == WorkKind.EVENT_REMINDER,
            ScheduledWork.state == WorkState.RUNNING,
            ScheduledWork.lease_token == claim.lease_token,
            ScheduledWork.lease_expires_at > now,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def _cancel(work: ScheduledWork, reason: str) -> None:
    work.state = WorkState.CANCELED
    work.failure_code = reason
    work.lease_token = None
    work.lease_expires_at = None


def finalize_reminder_claim(
    db: Session, claim: WorkClaim, *, now: datetime | None = None
) -> UUID | None:
    """Stage a recipient reference only if every current policy still admits it."""

    current = _current(now)
    reminder_id = db.scalar(
        select(ScheduledWork.reminder_id).where(
            ScheduledWork.id == claim.id,
            ScheduledWork.kind == WorkKind.EVENT_REMINDER,
        )
    )
    if reminder_id is None:
        return None
    source = db.execute(
        select(
            BoardEventReminder.board_id,
            BoardEventReminder.event_id,
            BoardEventReminder.recipient_id,
        ).where(BoardEventReminder.id == reminder_id)
    ).one_or_none()
    if source is None:
        return None
    board = db.scalar(
        select(Board)
        .where(Board.id == source.board_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    actor = db.scalar(
        select(User)
        .where(User.id == source.recipient_id)
        .execution_options(populate_existing=True)
    )
    actor_active = (
        actor is not None
        and not actor.is_deleted
        and actor.deleted_at is None
        and actor.status == UserStatus.ACTIVE.value
        and is_established_user(actor)
    )
    event = (
        db.scalar(
            select(BoardEvent)
            .where(
                BoardEvent.id == source.event_id,
                BoardEvent.board_id == source.board_id,
                _audience_clause(actor),
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if actor_active and actor is not None
        else None
    )
    reminder = db.scalar(
        select(BoardEventReminder)
        .where(BoardEventReminder.id == reminder_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    work = _locked_claim(db, claim, current)
    if work is None or work.reminder_id != reminder_id:
        return None
    grants = (
        list(
            db.scalars(
                select(BoardGrant).where(
                    BoardGrant.board_id == source.board_id,
                    BoardGrant.is_deleted.is_(False),
                    BoardGrant.deleted_at.is_(None),
                )
            )
        )
        if board is not None
        else []
    )
    occurrence = (
        occurrence_for_id(event, reminder.occurrence_id)
        if event is not None and reminder is not None
        else None
    )
    if (
        board is None
        or board.status != BoardStatus.ACTIVE
        or board.is_deleted
        or board.deleted_at is not None
        or not actor_active
        or actor is None
        or not can_access_board(board, actor, BoardPermission.VIEW, grants)
        or event is None
        or event.is_deleted
        or event.deleted_at is not None
        or event.archived
        or reminder is None
        or reminder.is_deleted
        or reminder.deleted_at is not None
        or reminder.recipient_id != actor.id
        or reminder.event_id != event.id
        or occurrence is None
        or occurrence_instant(event, occurrence)
        != reminder.occurrence_start_at.astimezone(current.tzinfo)
        or reminder.due_at != work.scheduled_for
        or work.scheduled_for > current
    ):
        _cancel(work, "source_unavailable")
        return None
    existing = db.scalar(
        select(InAppNotification).where(
            InAppNotification.work_id == work.id,
            InAppNotification.recipient_id == actor.id,
        )
    )
    notice = existing or InAppNotification(work_id=work.id, recipient_id=actor.id)
    if existing is None:
        db.add(notice)
        db.flush()
    work.state = WorkState.SUCCEEDED
    work.failure_code = None
    work.lease_token = None
    work.lease_expires_at = None
    return notice.id


def fail_reminder_work(db: Session, claim: WorkClaim, *, now: datetime | None = None) -> bool:
    current = _current(now)
    work = _locked_claim(db, claim, current)
    if work is None:
        return False
    if work.attempt_count >= MAX_ATTEMPTS:
        work.state = WorkState.FAILED
        work.failure_code = "attempts_exhausted"
    else:
        work.state = WorkState.PENDING
        work.next_attempt_at = current + timedelta(seconds=min(2**work.attempt_count, 300))
        work.failure_code = "delivery_failed"
    work.lease_token = None
    work.lease_expires_at = None
    return True


def execute_reminder_claim(
    engine: Engine, claim: WorkClaim, *, now: datetime | None = None
) -> UUID | None:
    try:
        with _session(engine) as db:
            notice_id = finalize_reminder_claim(db, claim, now=now)
            db.commit()
            return notice_id
    except Exception:
        logger.warning("Event reminder delivery failed; applying bounded retry")
        with _session(engine) as db:
            if fail_reminder_work(db, claim, now=now):
                db.commit()
        return None


def execute_due_reminders(
    engine: Engine, *, now: datetime | None = None, limit: int = MAX_CLAIM_BATCH
) -> list[UUID]:
    current = _current(now)
    with _session(engine) as db:
        claims = claim_due_reminder_work(db, now=current, limit=limit)
        db.commit()
    delivered: list[UUID] = []
    for claim in claims:
        notice_id = execute_reminder_claim(engine, claim, now=current)
        if notice_id is not None:
            delivered.append(notice_id)
    return delivered
