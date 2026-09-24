"""Current-user, audience-checked reminders for Board Event occurrences."""

from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies import require_legacy_capability
from app.common.listing.schemas import PaginationMetadata
from app.core.base_model import utc_now
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.access.users.permissions import Capability
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import _audience_clause, _event
from app.systems.boards.models import BoardPermission, BoardStatus
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.boards.reminder_service import (
    occurrence_for_id,
    occurrence_instant,
    reminder_due_at,
)
from app.systems.boards.router import _board_with_access
from app.systems.platform.scheduling.models import ScheduledWork, WorkKind, WorkState


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_READ))]
Database = Annotated[Session, Depends(get_db)]


class ReminderWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    occurrence_id: str = Field(min_length=1, max_length=100)
    timing: Literal["now", "start", "15m", "1d"]


class ReminderResponse(BaseModel):
    id: UUID
    event_id: UUID
    occurrence_id: str
    timing: Literal["now", "start", "15m", "1d"]
    occurrence_start_at: datetime
    due_at: datetime
    state: Literal["pending", "running", "succeeded", "failed", "canceled"]


class ReminderListResponse(BaseModel):
    items: list[ReminderResponse]
    pagination: PaginationMetadata


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail="Reminder not found")


def _response(reminder: BoardEventReminder, work: ScheduledWork) -> ReminderResponse:
    return ReminderResponse(
        id=reminder.id,
        event_id=reminder.event_id,
        occurrence_id=reminder.occurrence_id,
        timing=reminder.timing,
        occurrence_start_at=reminder.occurrence_start_at.astimezone(UTC),
        due_at=reminder.due_at.astimezone(UTC),
        state=work.state,
    )


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"code": "reminder_conflict", "message": "Reminder changed; retry"},
        ) from error
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="Reminders are unavailable"
        ) from error


@router.get("/{board_id}/reminders", response_model=ReminderListResponse)
def list_reminders(
    board_id: UUID,
    actor: Reader,
    db: Database,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ReminderListResponse:
    """Count only the recipient's pending, currently visible Event reminders."""

    _board_with_access(db, actor, board_id, BoardPermission.VIEW)
    visible = (
        select(BoardEventReminder.id)
        .join(BoardEvent, BoardEvent.id == BoardEventReminder.event_id)
        .join(ScheduledWork, ScheduledWork.reminder_id == BoardEventReminder.id)
        .where(
            BoardEventReminder.board_id == board_id,
            BoardEventReminder.recipient_id == actor.id,
            BoardEventReminder.is_deleted.is_(False),
            BoardEventReminder.deleted_at.is_(None),
            BoardEvent.is_deleted.is_(False),
            BoardEvent.deleted_at.is_(None),
            BoardEvent.archived.is_(False),
            _audience_clause(actor),
            ScheduledWork.kind == WorkKind.EVENT_REMINDER,
            ScheduledWork.state == WorkState.PENDING,
        )
    )
    total = db.scalar(select(func.count()).select_from(visible.subquery())) or 0
    rows = db.execute(
        select(BoardEventReminder, ScheduledWork)
        .join(ScheduledWork, ScheduledWork.reminder_id == BoardEventReminder.id)
        .where(BoardEventReminder.id.in_(visible))
        .order_by(BoardEventReminder.created_at.desc(), BoardEventReminder.id.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    return ReminderListResponse(
        items=[_response(reminder, work) for reminder, work in rows],
        pagination=PaginationMetadata(
            limit=limit,
            offset=offset,
            count=len(rows),
            total=total,
            has_more=offset + len(rows) < total,
        ),
    )


@router.post(
    "/{board_id}/events/{event_id}/reminders",
    response_model=ReminderResponse,
    status_code=status.HTTP_201_CREATED,
)
def set_reminder(
    board_id: UUID,
    event_id: UUID,
    payload: ReminderWrite,
    actor: Reader,
    db: Database,
) -> ReminderResponse:
    """Upsert one private choice without allowing a second delivered notice."""

    board = _board_with_access(db, actor, board_id, BoardPermission.VIEW, lock=True)
    if board.status != BoardStatus.ACTIVE:
        raise _not_found()
    event = _event(db, board.id, event_id, actor, lock=True)
    if event.archived:
        raise _not_found()
    occurrence = occurrence_for_id(event, payload.occurrence_id)
    if occurrence is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "occurrence_changed",
                "message": "Reopen the Event before setting a reminder",
            },
        )
    start = occurrence_instant(event, occurrence)
    due = reminder_due_at(start, payload.timing, now=utc_now())
    reminder = db.scalar(
        select(BoardEventReminder)
        .where(
            BoardEventReminder.event_id == event.id,
            BoardEventReminder.recipient_id == actor.id,
            BoardEventReminder.occurrence_id == occurrence.id,
        )
        .with_for_update()
    )
    work = (
        db.scalar(
            select(ScheduledWork).where(ScheduledWork.reminder_id == reminder.id).with_for_update()
        )
        if reminder is not None
        else None
    )
    if work is not None and work.state in (WorkState.SUCCEEDED, WorkState.RUNNING):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "reminder_already_processing",
                "message": "Reminder already delivered or processing",
            },
        )
    if reminder is None:
        reminder = BoardEventReminder(
            board_id=board.id,
            event_id=event.id,
            recipient_id=actor.id,
            occurrence_id=occurrence.id,
            occurrence_start_at=start,
            timing=payload.timing,
            due_at=due,
        )
        db.add(reminder)
        try:
            db.flush()
        except IntegrityError as error:
            db.rollback()
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={"code": "reminder_conflict", "message": "Reminder changed; retry"},
            ) from error
    else:
        reminder.occurrence_start_at = start
        reminder.timing = payload.timing
        reminder.due_at = due
    if work is None:
        work = ScheduledWork(
            kind=WorkKind.EVENT_REMINDER,
            reminder_id=reminder.id,
            scheduled_for=due,
            next_attempt_at=due,
        )
        db.add(work)
    else:
        work.state = WorkState.PENDING
        work.attempt_count = 0
        work.failure_code = None
        work.lease_token = None
        work.lease_expires_at = None
        work.scheduled_for = due
        work.next_attempt_at = due
    _commit(db)
    db.refresh(reminder)
    db.refresh(work)
    return _response(reminder, work)


@router.delete("/{board_id}/reminders/{reminder_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel_reminder(board_id: UUID, reminder_id: UUID, actor: Reader, db: Database) -> None:
    board = _board_with_access(db, actor, board_id, BoardPermission.VIEW, lock=True)
    reminder = db.scalar(
        select(BoardEventReminder)
        .join(BoardEvent, BoardEvent.id == BoardEventReminder.event_id)
        .where(
            BoardEventReminder.id == reminder_id,
            BoardEventReminder.board_id == board.id,
            BoardEventReminder.recipient_id == actor.id,
            BoardEvent.is_deleted.is_(False),
            BoardEvent.deleted_at.is_(None),
            BoardEvent.archived.is_(False),
            _audience_clause(actor),
        )
        .with_for_update(of=BoardEventReminder)
    )
    if reminder is None:
        raise _not_found()
    work = db.scalar(
        select(ScheduledWork).where(ScheduledWork.reminder_id == reminder.id).with_for_update()
    )
    if work is None:
        raise _not_found()
    if work.state == WorkState.PENDING:
        work.state = WorkState.CANCELED
        work.failure_code = "recipient_canceled"
        _commit(db)
