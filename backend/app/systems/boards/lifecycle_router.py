"""Board-owned permanent deletion with complete child/work inventory."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.common.dependencies import require_admin, require_fresh_exact_admin
from app.core.config import get_settings
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.boards.attachment_models import (
    BoardAttachment,
    BoardPostRevisionAttachment,
)
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardGroup, BoardScope, BoardStatus, BoardWidget
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.post_work import delete_post_work
from app.systems.boards.record_link_models import (
    BoardPostRevisionRecordLink,
    BoardRecordLink,
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
from app.systems.sandbox.lifecycle.purge_support import (
    PURGE_DISABLED_MESSAGE,
    last_successful_backup_at,
)
from app.systems.sandbox.lifecycle.purge_support import purge_row_state as _row_state
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleImpactResponse,
    LifecycleMutationResponse,
    LifecycleOperation,
    LifecyclePurgePreviewResponse,
    LifecyclePurgeRequest,
    LifecycleTargetType,
)
from app.systems.sandbox.lifecycle.service import (
    challenge_impact_digest,
    issue_challenge,
    verify_challenge,
)

router = APIRouter(prefix="/boards", tags=["boards"])
Admin = Annotated[User, Depends(require_admin)]
Database = Annotated[Session, Depends(get_db)]

_CHILD_MODELS = (
    BoardGroup,
    BoardWidget,
    BoardEvent,
    BoardEventReminder,
    BoardPost,
    BoardAttachment,
    BoardRecordLink,
    File,
)


def _error(exc: LifecycleError) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code,
        detail={"code": str(exc.code), "message": exc.detail},
    )


class BoardScopeFixed(LifecycleError):
    code = "board_scope_fixed"


def _require_purge_enabled() -> None:
    if not get_settings().lifecycle_purge_enabled:
        raise LifecyclePurgeDisabled(PURGE_DISABLED_MESSAGE)


def _require_project_board(db: Session, board_id: UUID) -> None:
    """Only a project Board is purged on its own.

    The company Board is never deleted, and a department Board is deleted only by
    its department's purge, so a closed department always has its Board to reopen.
    """

    scope = db.scalar(select(Board.scope).where(Board.id == board_id))
    if scope is not None and scope != BoardScope.PROJECT.value:
        raise BoardScopeFixed(
            "Only project Boards can be permanently deleted; "
            "a department Board is deleted with its department"
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

    post_ids = [item.id for item in children if isinstance(item, BoardPost)]
    if post_ids:
        work_statement = (
            select(ScheduledWork)
            .where(
                ScheduledWork.kind == WorkKind.POST_PUBLISH,
                ScheduledWork.post_id.in_(post_ids),
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
        select(BoardPostRevision)
        .where(
            BoardPostRevision.post_id.in_(
                select(BoardPost.id).where(BoardPost.board_id == board_id)
            )
        )
        .order_by(BoardPostRevision.post_id, BoardPostRevision.id)
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
            select(BoardPostRevisionAttachment)
            .where(
                BoardPostRevisionAttachment.revision_id.in_(
                    [revision.id for revision in revisions]
                )
            )
            .order_by(BoardPostRevisionAttachment.id)
        )
        if lock:
            snapshot_statement = snapshot_statement.with_for_update().execution_options(
                populate_existing=True
            )
        snapshots = db.scalars(snapshot_statement).all()
        rows.extend(_row_state(snapshot) for snapshot in snapshots)
        children.extend(snapshots)
        record_snapshot_statement = (
            select(BoardPostRevisionRecordLink)
            .where(
                BoardPostRevisionRecordLink.revision_id.in_(
                    [revision.id for revision in revisions]
                )
            )
            .order_by(BoardPostRevisionRecordLink.id)
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
        _require_project_board(db, board_id)
        impact, board, _ = _impact(db, user.id, board_id)
        issued = issue_challenge(db, user.id, "purge", "board", board_id, impact.impact_digest)
        return LifecyclePurgePreviewResponse(
            impact=impact,
            token=issued.token,
            expires_at=issued.expires_at,
            confirmation_name=board.name,
            last_successful_backup_at=last_successful_backup_at(db),
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
        _require_project_board(db, board_id)
        board = db.get(Board, board_id)
        if board is None:
            raise LifecycleNotFound("Board not found")
        if payload.confirmation_name != board.name:
            raise LifecycleConfirmationNameMismatch("Confirmation must match the Board name")
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
        _require_purge_enabled()
        require_fresh_exact_admin(db, user.id)
        impact, board, children = _impact(db, user.id, board_id, lock=True)
        if impact.impact_digest != challenge.impact_digest:
            raise LifecyclePlanDriftError("Board changed after preview; obtain a new preview")
        # A list order alone does not constrain SQLAlchemy's unit-of-work flush.
        # Remove notifications and work, then revisions, before deleting their
        # post parents.
        for child in children:
            if isinstance(child, BoardPost):
                delete_post_work(db, child)
            if isinstance(child, BoardEvent):
                delete_event_reminders(db, child.id)
        for child in children:
            if isinstance(
                child,
                (
                    BoardPostRevisionAttachment,
                    BoardPostRevisionRecordLink,
                    BoardAttachment,
                    BoardRecordLink,
                ),
            ):
                db.delete(child)
        db.flush()
        for child in children:
            if isinstance(child, BoardPostRevision):
                db.delete(child)
        db.flush()
        for child in children:
            if not isinstance(
                child,
                (
                    BoardPostRevision,
                    BoardPostRevisionAttachment,
                    BoardPostRevisionRecordLink,
                    BoardAttachment,
                    BoardRecordLink,
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
