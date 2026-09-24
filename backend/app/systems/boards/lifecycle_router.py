"""Board-owned permanent deletion with complete child/work inventory."""

import hashlib
import json
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.common.dependencies import require_fresh_exact_admin, require_roles
from app.core.base_model import BaseModel
from app.core.config import get_settings
from app.core.database import get_db
from app.systems.access.users.models import User, UserRole
from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.announcement_personal_models import BoardAnnouncementPersonalState
from app.systems.boards.announcement_work import delete_announcement_work
from app.systems.boards.attachment_models import (
    BoardAnnouncementRevisionAttachment,
    BoardContentAttachment,
)
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import (
    Board,
    BoardGrant,
    BoardRecordPlacement,
    BoardStatus,
    BoardWidget,
)
from app.systems.boards.personal_models import BoardFavorite, BoardHome
from app.systems.boards.record_link_models import (
    BoardAnnouncementRevisionRecordLink,
    BoardContentRecordLink,
)
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.boards.reminder_service import delete_event_reminders
from app.systems.manage.audit.context import get_audit_context
from app.systems.platform.files.models import File
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork, WorkKind
from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleConfirmationNameMismatch,
    LifecycleError,
    LifecycleNotFound,
    LifecyclePlanDriftError,
    LifecyclePurgeDisabled,
    LifecyclePurgePreconditionError,
)
from app.systems.sandbox.lifecycle.planner import canonical_lifecycle_digest
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleImpactResponse,
    LifecycleMutationResponse,
    LifecycleOperation,
    LifecyclePurgePreviewResponse,
    LifecyclePurgeRequest,
    LifecycleRowState,
    LifecycleTargetType,
)
from app.systems.sandbox.lifecycle.service import (
    challenge_impact_digest,
    issue_challenge,
    verify_challenge,
)

router = APIRouter(prefix="/boards", tags=["boards"])
Admin = Annotated[User, Depends(require_roles(UserRole.ADMIN))]
Database = Annotated[Session, Depends(get_db)]

_CHILD_MODELS = (
    BoardGrant,
    BoardRecordPlacement,
    BoardWidget,
    BoardFavorite,
    BoardHome,
    BoardEvent,
    BoardEventReminder,
    BoardAnnouncement,
    BoardContentAttachment,
    BoardContentRecordLink,
    File,
)


def _error(exc: LifecycleError) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code,
        detail={"code": str(exc.code), "message": exc.detail},
    )


def _require_purge_enabled() -> None:
    if not get_settings().lifecycle_purge_enabled:
        raise LifecyclePurgeDisabled("Permanent Board deletion is disabled")


def _row_state(row: BaseModel | ScheduledWork) -> LifecycleRowState:
    # The impact carries no Board content, but its digest reacts to every retained
    # column, including personal preferences and event audience references.
    state = {column.name: getattr(row, column.name) for column in row.__table__.columns}
    fingerprint = hashlib.sha256(
        json.dumps(state, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()
    return LifecycleRowState(
        entity_type=row.__tablename__,
        entity_id=row.id,
        is_deleted=row.is_deleted if isinstance(row, BaseModel) else False,
        deleted_at=row.deleted_at if isinstance(row, BaseModel) else None,
        updated_at=row.updated_at,
        state_fingerprint=fingerprint,
    )


def _impact(
    db: Session, actor_id: UUID, board_id: UUID, *, lock: bool = False
) -> tuple[LifecycleImpactResponse, Board, list[object]]:
    board_statement = select(Board).where(Board.id == board_id)
    if lock:
        board_statement = board_statement.with_for_update().execution_options(
            populate_existing=True
        )
    board = db.scalar(board_statement)
    if board is None:
        raise LifecycleNotFound("Board not found")
    if board.status != BoardStatus.ARCHIVED and not (
        board.is_deleted and board.deleted_at is not None
    ):
        raise LifecyclePurgePreconditionError("Archive or soft-delete the Board before purging")

    rows = [_row_state(board)]
    children: list[object] = []
    # Every Board writer must take the Board lock before a child lock. The parent
    # FOR UPDATE lock also blocks new FK references until this transaction ends.
    for model in _CHILD_MODELS:
        statement = select(model).where(model.board_id == board_id).order_by(model.id)
        if lock:
            statement = statement.with_for_update().execution_options(populate_existing=True)
        selected = db.scalars(statement).all()
        children.extend(selected)
        rows.extend(_row_state(item) for item in selected)
    if any(isinstance(item, File) and item.state != "purged" for item in children):
        raise LifecyclePurgePreconditionError(
            "Purge every Board file before permanently deleting the Board"
        )

    announcement_ids = [item.id for item in children if isinstance(item, BoardAnnouncement)]
    if announcement_ids:
        personal_statement = (
            select(BoardAnnouncementPersonalState)
            .where(BoardAnnouncementPersonalState.announcement_id.in_(announcement_ids))
            .order_by(
                BoardAnnouncementPersonalState.announcement_id,
                BoardAnnouncementPersonalState.id,
            )
        )
        if lock:
            personal_statement = personal_statement.with_for_update().execution_options(
                populate_existing=True
            )
        personal_states = db.scalars(personal_statement).all()
        rows.extend(_row_state(item) for item in personal_states)
        children.extend(personal_states)

        work_statement = (
            select(ScheduledWork)
            .where(
                ScheduledWork.kind == WorkKind.ANNOUNCEMENT_PUBLISH,
                ScheduledWork.announcement_id.in_(announcement_ids),
            )
            .order_by(ScheduledWork.id)
        )
        if lock:
            work_statement = work_statement.with_for_update().execution_options(
                populate_existing=True
            )
        work = db.scalars(work_statement).all()
        rows.extend(_row_state(item) for item in work)
        if work:
            notification_statement = (
                select(InAppNotification)
                .where(InAppNotification.work_id.in_([item.id for item in work]))
                .order_by(InAppNotification.id)
            )
            if lock:
                notification_statement = notification_statement.with_for_update().execution_options(
                    populate_existing=True
                )
            rows.extend(_row_state(item) for item in db.scalars(notification_statement))

    reminder_ids = [item.id for item in children if isinstance(item, BoardEventReminder)]
    if reminder_ids:
        reminder_work_statement = (
            select(ScheduledWork)
            .where(
                ScheduledWork.kind == WorkKind.EVENT_REMINDER,
                ScheduledWork.reminder_id.in_(reminder_ids),
            )
            .order_by(ScheduledWork.id)
        )
        if lock:
            reminder_work_statement = reminder_work_statement.with_for_update().execution_options(
                populate_existing=True
            )
        reminder_work = db.scalars(reminder_work_statement).all()
        rows.extend(_row_state(item) for item in reminder_work)
        if reminder_work:
            reminder_notice_statement = (
                select(InAppNotification)
                .where(InAppNotification.work_id.in_([item.id for item in reminder_work]))
                .order_by(InAppNotification.id)
            )
            if lock:
                reminder_notice_statement = (
                    reminder_notice_statement.with_for_update().execution_options(
                        populate_existing=True
                    )
                )
            rows.extend(_row_state(item) for item in db.scalars(reminder_notice_statement))

    revision_statement = (
        select(BoardAnnouncementRevision)
        .where(
            BoardAnnouncementRevision.announcement_id.in_(
                select(BoardAnnouncement.id).where(BoardAnnouncement.board_id == board_id)
            )
        )
        .order_by(BoardAnnouncementRevision.announcement_id, BoardAnnouncementRevision.id)
    )
    if lock:
        revision_statement = revision_statement.with_for_update().execution_options(
            populate_existing=True
        )
    revisions = db.scalars(revision_statement).all()
    rows.extend(_row_state(revision) for revision in revisions)
    children.extend(revisions)
    if revisions:
        snapshot_statement = (
            select(BoardAnnouncementRevisionAttachment)
            .where(
                BoardAnnouncementRevisionAttachment.revision_id.in_(
                    [revision.id for revision in revisions]
                )
            )
            .order_by(BoardAnnouncementRevisionAttachment.id)
        )
        if lock:
            snapshot_statement = snapshot_statement.with_for_update().execution_options(
                populate_existing=True
            )
        snapshots = db.scalars(snapshot_statement).all()
        rows.extend(_row_state(snapshot) for snapshot in snapshots)
        children.extend(snapshots)
        record_snapshot_statement = (
            select(BoardAnnouncementRevisionRecordLink)
            .where(
                BoardAnnouncementRevisionRecordLink.revision_id.in_(
                    [revision.id for revision in revisions]
                )
            )
            .order_by(BoardAnnouncementRevisionRecordLink.id)
        )
        if lock:
            record_snapshot_statement = (
                record_snapshot_statement.with_for_update().execution_options(
                    populate_existing=True
                )
            )
        record_snapshots = db.scalars(record_snapshot_statement).all()
        rows.extend(_row_state(snapshot) for snapshot in record_snapshots)
        children.extend(record_snapshots)

    digest = canonical_lifecycle_digest(
        LifecycleOperation.PURGE,
        LifecycleTargetType.BOARD,
        board_id,
        actor_id,
        rows,
    )
    return (
        LifecycleImpactResponse(
            target_type=LifecycleTargetType.BOARD,
            target_id=board_id,
            operation=LifecycleOperation.PURGE,
            actor_id=actor_id,
            rows=rows,
            impact_digest=digest,
        ),
        board,
        children,
    )


@router.post("/{board_id}/purge/preview", response_model=LifecyclePurgePreviewResponse)
def preview_board_purge(
    board_id: UUID, user: Admin, db: Database, response: Response
) -> LifecyclePurgePreviewResponse:
    response.headers["Cache-Control"] = "no-store"
    try:
        _require_purge_enabled()
        require_fresh_exact_admin(db, user.id)
        impact, _, _ = _impact(db, user.id, board_id)
        issued = issue_challenge(db, user.id, "purge", "board", board_id, impact.impact_digest)
        return LifecyclePurgePreviewResponse(
            impact=impact,
            token=issued.token,
            expires_at=issued.expires_at,
            confirmation_name=str(board_id),
        )
    except LifecycleError as exc:
        raise _error(exc) from exc


@router.post("/{board_id}/purge", response_model=LifecycleMutationResponse)
def purge_board(
    board_id: UUID,
    payload: LifecyclePurgeRequest,
    user: Admin,
    db: Database,
    response: Response,
) -> LifecycleMutationResponse:
    response.headers["Cache-Control"] = "no-store"
    try:
        _require_purge_enabled()
        if payload.confirmation_name != str(board_id):
            raise LifecycleConfirmationNameMismatch("Confirmation must match the Board ID")
        digest = challenge_impact_digest(db, payload.token, user.id, "purge", "board", board_id)
        challenge = verify_challenge(
            db,
            payload.token,
            user.id,
            "purge",
            "board",
            board_id,
            digest,
            user.email,
            payload.password,
        )
        require_fresh_exact_admin(db, user.id)
        impact, board, children = _impact(db, user.id, board_id, lock=True)
        if impact.impact_digest != challenge.impact_digest:
            raise LifecyclePlanDriftError("Board changed after preview; obtain a new preview")
        # A list order alone does not constrain SQLAlchemy's unit-of-work flush.
        # Remove notifications and work, then personal states and revisions,
        # before deleting their announcement parents.
        for child in children:
            if isinstance(child, BoardAnnouncement):
                delete_announcement_work(db, child)
            if isinstance(child, BoardEvent):
                delete_event_reminders(db, child.id)
        for child in children:
            if isinstance(
                child,
                (
                    BoardAnnouncementRevisionAttachment,
                    BoardAnnouncementRevisionRecordLink,
                    BoardContentAttachment,
                    BoardContentRecordLink,
                ),
            ):
                db.delete(child)
        db.flush()
        for child in children:
            if isinstance(child, (BoardAnnouncementPersonalState, BoardAnnouncementRevision)):
                db.delete(child)
        db.flush()
        for child in children:
            if not isinstance(
                child,
                (
                    BoardAnnouncementPersonalState,
                    BoardAnnouncementRevision,
                    BoardAnnouncementRevisionAttachment,
                    BoardAnnouncementRevisionRecordLink,
                    BoardContentAttachment,
                    BoardContentRecordLink,
                    File,
                    BoardEventReminder,
                ),
            ):
                db.delete(child)
        db.flush()
        for child in children:
            if isinstance(child, File):
                db.delete(child)
        db.flush()
        db.delete(board)
        db.commit()
        return LifecycleMutationResponse(
            impact=impact,
            operation_id=get_audit_context(db).request_id,
        )
    except LifecycleError as exc:
        db.rollback()
        raise _error(exc) from exc
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={
                "code": "board_purge_conflict",
                "message": "Board dependencies changed; obtain a new preview",
            },
        ) from exc
