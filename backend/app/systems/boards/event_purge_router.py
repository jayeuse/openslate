"""Administrator-confirmed deletion of an archived Board event and its references."""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import Select, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.common.dependencies import require_admin, require_fresh_exact_admin
from app.core.config import get_settings
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.boards.attachment_models import BoardAttachment
from app.systems.boards.attachment_service import delete_event_attachments
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board
from app.systems.boards.record_link_models import BoardRecordLink
from app.systems.boards.record_link_service import delete_content_links
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.boards.reminder_service import delete_event_reminders
from app.systems.manage.audit.context import get_audit_context
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
    purge_row_state,
)
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

router = APIRouter(tags=["boards"])
Admin = Annotated[User, Depends(require_admin)]
Database = Annotated[Session, Depends(get_db)]


def _enabled() -> None:
    if not get_settings().lifecycle_purge_enabled:
        raise LifecyclePurgeDisabled(PURGE_DISABLED_MESSAGE)


def _mapped(exc: LifecycleError) -> HTTPException:
    return HTTPException(exc.status_code, detail={"code": str(exc.code), "message": exc.detail})


def _target(
    db: Session, board_id: UUID, event_id: UUID, *, lock: bool = False
) -> tuple[Board, BoardEvent]:
    board_statement = select(Board).where(Board.id == board_id)
    event_statement = select(BoardEvent).where(
        BoardEvent.id == event_id, BoardEvent.board_id == board_id
    )
    if lock:
        board_statement = board_statement.with_for_update().execution_options(
            populate_existing=True
        )
        event_statement = event_statement.with_for_update().execution_options(
            populate_existing=True
        )
    board = db.scalar(board_statement)
    if board is None:
        raise LifecycleNotFound("Board not found")
    event = db.scalar(event_statement)
    if event is None:
        raise LifecycleNotFound("Board event not found")
    if not event.archived:
        raise LifecyclePurgePreconditionError("Archive the event before permanently deleting it")
    return board, event


def _impact(
    db: Session, actor_id: UUID, event: BoardEvent, *, lock: bool = False
) -> LifecycleImpactResponse:
    rows = [purge_row_state(event)]

    def statement_locked(statement: Select[Any]) -> Select[Any]:
        return (
            statement.with_for_update().execution_options(populate_existing=True)
            if lock
            else statement
        )

    for model in (BoardAttachment, BoardRecordLink, BoardEventReminder):
        rows.extend(
            purge_row_state(item)
            for item in db.scalars(
                statement_locked(select(model).where(model.event_id == event.id).order_by(model.id))
            )
        )
    reminder_ids = select(BoardEventReminder.id).where(BoardEventReminder.event_id == event.id)
    work = list(
        db.scalars(
            statement_locked(
                select(ScheduledWork)
                .where(
                    ScheduledWork.kind == WorkKind.EVENT_REMINDER,
                    ScheduledWork.reminder_id.in_(reminder_ids),
                )
                .order_by(ScheduledWork.id)
            )
        )
    )
    rows.extend(purge_row_state(item) for item in work)
    if work:
        rows.extend(
            purge_row_state(item)
            for item in db.scalars(
                statement_locked(
                    select(InAppNotification)
                    .where(InAppNotification.work_id.in_([item.id for item in work]))
                    .order_by(InAppNotification.id)
                )
            )
        )
    digest = canonical_lifecycle_digest(
        LifecycleOperation.PURGE, LifecycleTargetType.BOARD_EVENT, event.id, actor_id, rows
    )
    return LifecycleImpactResponse(
        target_type=LifecycleTargetType.BOARD_EVENT,
        target_id=event.id,
        operation=LifecycleOperation.PURGE,
        actor_id=actor_id,
        rows=rows,
        impact_digest=digest,
    )


@router.post(
    "/{board_id}/events/{event_id}/purge/preview", response_model=LifecyclePurgePreviewResponse
)
def preview_event_purge(
    board_id: UUID, event_id: UUID, user: Admin, db: Database, response: Response
) -> LifecyclePurgePreviewResponse:
    response.headers["Cache-Control"] = "no-store"
    try:
        _enabled()
        require_fresh_exact_admin(db, user.id)
        _, event = _target(db, board_id, event_id)
        impact = _impact(db, user.id, event)
        name = event.title
        issued = issue_challenge(
            db, user.id, "purge", "board_event", event_id, impact.impact_digest
        )
        return LifecyclePurgePreviewResponse(
            impact=impact,
            token=issued.token,
            expires_at=issued.expires_at,
            confirmation_name=name,
            last_successful_backup_at=last_successful_backup_at(db),
        )
    except LifecycleError as exc:
        db.rollback()
        raise _mapped(exc) from exc


@router.post("/{board_id}/events/{event_id}/purge", response_model=LifecycleMutationResponse)
def purge_event(
    board_id: UUID,
    event_id: UUID,
    payload: LifecyclePurgeRequest,
    user: Admin,
    db: Database,
    response: Response,
) -> LifecycleMutationResponse:
    response.headers["Cache-Control"] = "no-store"
    actor_id, email = user.id, user.email
    try:
        _enabled()
        require_fresh_exact_admin(db, actor_id)
        _, event = _target(db, board_id, event_id)
        if payload.confirmation_name != event.title:
            raise LifecycleConfirmationNameMismatch("Confirmation must match the event name")
        digest = challenge_impact_digest(
            db, payload.token, actor_id, "purge", "board_event", event_id
        )
        challenge = verify_challenge(
            db,
            payload.token,
            actor_id,
            "purge",
            "board_event",
            event_id,
            digest,
            email,
            payload.password,
        )
        _enabled()
        require_fresh_exact_admin(db, actor_id)
        board, event = _target(db, board_id, event_id, lock=True)
        impact = _impact(db, actor_id, event, lock=True)
        if impact.impact_digest != challenge.impact_digest:
            raise LifecyclePlanDriftError("Event changed after preview; obtain a new preview")
        if payload.confirmation_name != event.title:
            raise LifecycleConfirmationNameMismatch("Confirmation must match the event name")
        delete_event_attachments(db, event.id)
        delete_content_links(db, "event", event.id)
        delete_event_reminders(db, event.id)
        db.delete(event)
        board.revision += 1
        db.commit()
        return LifecycleMutationResponse(
            impact=impact, operation_id=get_audit_context(db).request_id
        )
    except LifecycleError as exc:
        db.rollback()
        raise _mapped(exc) from exc
    except (IntegrityError, OperationalError) as exc:
        db.rollback()
        raise HTTPException(
            409,
            detail={
                "code": "event_purge_conflict",
                "message": "Event dependencies changed; obtain a new preview",
            },
        ) from exc
