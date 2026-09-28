"""Event reminder delivery: each due occurrence notifies every current Board reader once."""

import logging
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import Engine, and_, or_, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.session import AuditSession
from app.systems.boards.access import board_reader_ids
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardStatus
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.boards.reminder_service import occurrence_at, reminder_due_at
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.platform.scheduling.materializer import materialize_event_reminders
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
) -> list[UUID]:
    """Stage one notification for each current reader, only while the occurrence still exists.

    Returns the IDs of the new notifications; the caller owns commit or rollback.
    """

    current = _current(now)
    source = db.execute(
        select(ScheduledWork.reminder_id, ScheduledWork.occurrence_start_at).where(
            ScheduledWork.id == claim.id,
            ScheduledWork.kind == WorkKind.EVENT_REMINDER,
        )
    ).one_or_none()
    if source is None or source.reminder_id is None or source.occurrence_start_at is None:
        return []
    parents = db.execute(
        select(BoardEventReminder.board_id, BoardEventReminder.event_id).where(
            BoardEventReminder.id == source.reminder_id
        )
    ).one_or_none()
    if parents is None:
        return []
    # Board writers lock the Board before the event and the reminder.
    board = db.scalar(
        select(Board)
        .where(Board.id == parents.board_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    event = db.scalar(
        select(BoardEvent)
        .where(BoardEvent.id == parents.event_id, BoardEvent.board_id == parents.board_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    reminder = db.scalar(
        select(BoardEventReminder)
        .where(BoardEventReminder.id == source.reminder_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    work = _locked_claim(db, claim, current)
    if work is None or work.reminder_id != source.reminder_id:
        return []
    start = source.occurrence_start_at
    if (
        board is None
        or board.status != BoardStatus.ACTIVE
        or board.is_deleted
        or board.deleted_at is not None
        or event is None
        or event.is_deleted
        or event.deleted_at is not None
        or event.archived
        or reminder is None
        or reminder.is_deleted
        or reminder.event_id != event.id
        or occurrence_at(event, start) is None
        or reminder_due_at(start, reminder.timing) != work.scheduled_for
        or work.scheduled_for > current
    ):
        _cancel(work, "source_unavailable")
        return []
    delivered = set(
        db.scalars(
            select(InAppNotification.recipient_id).where(InAppNotification.work_id == work.id)
        )
    )
    notices = [
        InAppNotification(work_id=work.id, recipient_id=recipient_id)
        for recipient_id in sorted(board_reader_ids(db, board))
        if recipient_id not in delivered
    ]
    db.add_all(notices)
    db.flush()
    work.state = WorkState.SUCCEEDED
    work.failure_code = None
    work.lease_token = None
    work.lease_expires_at = None
    return [notice.id for notice in notices]


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
) -> list[UUID]:
    try:
        with _session(engine) as db:
            notice_ids = finalize_reminder_claim(db, claim, now=now)
            db.commit()
            return notice_ids
    except Exception:
        logger.warning("Event reminder delivery failed; applying bounded retry")
        with _session(engine) as db:
            if fail_reminder_work(db, claim, now=now):
                db.commit()
        return []


def execute_due_reminders(
    engine: Engine, *, now: datetime | None = None, limit: int = MAX_CLAIM_BATCH
) -> list[UUID]:
    current = _current(now)
    with _session(engine) as db:
        materialize_event_reminders(db, now=current)
        db.commit()
    with _session(engine) as db:
        claims = claim_due_reminder_work(db, now=current, limit=limit)
        db.commit()
    delivered: list[UUID] = []
    for claim in claims:
        delivered.extend(execute_reminder_claim(engine, claim, now=current))
    return delivered
