"""Bounded scheduled Board announcement publication without recipient fanout."""

import logging
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import Engine, and_, or_, select
from sqlalchemy.orm import Session, joinedload
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.session import AuditSession
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.access.users.permissions import Capability, has_capability
from app.systems.boards.access import can_access_board
from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.announcement_service import (
    audience_clause,
    board_grants,
    publish_locked,
    write_manager,
)
from app.systems.boards.models import Board, BoardPermission, BoardStatus
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.platform.scheduling.models import ScheduledWork, WorkKind, WorkState
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
        request_path="/internal/boards/announcement-scheduler",
    )
    return db


def claim_due_announcement_work(
    db: Session, *, now: datetime | None = None, limit: int = MAX_CLAIM_BATCH
) -> list[WorkClaim]:
    """Claim only due announcement work, including expired leases, without waiting."""

    if not 1 <= limit <= MAX_CLAIM_BATCH:
        raise ValueError("Announcement claim limit is out of range")
    current = _current(now)
    rows = list(
        db.scalars(
            select(ScheduledWork)
            .where(
                ScheduledWork.kind == WorkKind.ANNOUNCEMENT_PUBLISH,
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
            ScheduledWork.kind == WorkKind.ANNOUNCEMENT_PUBLISH,
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


def _current_actor(db: Session, actor_id: UUID) -> User | None:
    actor = db.scalar(
        select(User)
        .options(joinedload(User.role))
        .where(User.id == actor_id)
        .with_for_update(of=User)
        .execution_options(populate_existing=True)
    )
    if (
        actor is None
        or actor.is_deleted
        or actor.deleted_at is not None
        or actor.status != UserStatus.ACTIVE.value
        or not is_established_user(actor)
    ):
        return None
    role = db.scalar(
        select(Role)
        .where(Role.id == actor.role_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if (
        role is None
        or role.is_deleted
        or role.deleted_at is not None
        or not has_capability(role, Capability.RECORDS_READ)
        or not has_capability(role, Capability.RECORDS_WRITE)
    ):
        return None
    return actor


def finalize_announcement_claim(
    db: Session, claim: WorkClaim, *, now: datetime | None = None
) -> UUID | None:
    """Stage one publication and result together; caller owns commit or rollback."""

    current = _current(now)
    source = db.execute(
        select(ScheduledWork.announcement_id, ScheduledWork.scheduling_actor_id).where(
            ScheduledWork.id == claim.id,
            ScheduledWork.kind == WorkKind.ANNOUNCEMENT_PUBLISH,
        )
    ).one_or_none()
    if source is None or source.announcement_id is None or source.scheduling_actor_id is None:
        return None
    board_id = db.scalar(
        select(BoardAnnouncement.board_id).where(BoardAnnouncement.id == source.announcement_id)
    )
    if board_id is None:
        return None
    # Board mutations lock this parent before announcement children and work rows.
    board = db.scalar(
        select(Board)
        .where(Board.id == board_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    item = db.scalar(
        select(BoardAnnouncement)
        .where(BoardAnnouncement.id == source.announcement_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    actor = _current_actor(db, source.scheduling_actor_id)
    board_access = (
        board is not None
        and actor is not None
        and can_access_board(board, actor, BoardPermission.EDIT, board_grants(db, board))
    )
    publication_access = (
        board is not None
        and item is not None
        and actor is not None
        and (item.author_id == actor.id or write_manager(db, board, actor))
    )
    audience_access = (
        item is not None
        and actor is not None
        and db.scalar(
            select(BoardAnnouncement.id).where(
                BoardAnnouncement.id == item.id, audience_clause(BoardAnnouncement, actor)
            )
        )
        is not None
    )
    work = _locked_claim(db, claim, current)
    if work is None or work.announcement_id != source.announcement_id:
        return None
    if (
        board is None
        or board.is_deleted
        or board.deleted_at is not None
        or board.status != BoardStatus.ACTIVE
        or item is None
        or item.board_id != board.id
        or item.is_deleted
        or item.deleted_at is not None
        or item.status != "scheduled"
        or item.revision != work.source_revision
        or item.publish_at != work.scheduled_for
        or work.scheduled_for > current
        or (item.expires_at is not None and item.expires_at <= current)
        or not board_access
        or not publication_access
        or not audience_access
        or actor is None
        or actor.id != work.scheduling_actor_id
    ):
        _cancel(work, "source_unavailable")
        return None
    # A prior publication with this key cannot be the output of a still-running
    # work row: successful publication and work completion commit atomically.
    if (
        db.scalar(
            select(BoardAnnouncementRevision.id).where(
                BoardAnnouncementRevision.announcement_id == item.id,
                BoardAnnouncementRevision.publication_key == work.id,
            )
        )
        is not None
    ):
        _cancel(work, "publication_key_conflict")
        return None
    revision = publish_locked(
        db,
        board,
        item,
        actor,
        publication_key=work.id,
        published_at=current,
        board_revision=board.revision,
        announcement_revision=work.source_revision,
        scheduled_work=work,
    )
    db.flush()
    work.state = WorkState.SUCCEEDED
    work.publication_result_id = revision.id
    work.failure_code = None
    work.lease_token = None
    work.lease_expires_at = None
    return revision.id


def fail_announcement_work(db: Session, claim: WorkClaim, *, now: datetime | None = None) -> bool:
    """Release only a current announcement lease with bounded retry/backoff."""

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
        work.failure_code = "publication_failed"
    work.lease_token = None
    work.lease_expires_at = None
    return True


def execute_announcement_claim(
    engine: Engine, claim: WorkClaim, *, now: datetime | None = None
) -> UUID | None:
    """Commit one lease's publication or schedule a retry after rollback."""

    try:
        with _session(engine) as db:
            result_id = finalize_announcement_claim(db, claim, now=now)
            db.commit()
            return result_id
    except Exception:
        logger.warning("Scheduled announcement attempt failed; applying bounded retry")
        with _session(engine) as db:
            if fail_announcement_work(db, claim, now=now):
                db.commit()
        return None


def execute_due_announcement_publications(
    engine: Engine, *, now: datetime | None = None, limit: int = MAX_CLAIM_BATCH
) -> list[UUID]:
    """Claim and execute one bounded announcement-only batch."""

    current = _current(now)
    with _session(engine) as db:
        claims = claim_due_announcement_work(db, now=current, limit=limit)
        db.commit()
    completed: list[UUID] = []
    for claim in claims:
        result_id = execute_announcement_claim(engine, claim, now=now)
        if result_id is not None:
            completed.append(result_id)
    return completed
