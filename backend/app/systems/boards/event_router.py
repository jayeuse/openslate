"""Board event series, their author-set reminders, and bounded occurrence listing."""

from dataclasses import asdict
from datetime import UTC, datetime
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user
from app.common.listing import (
    ListQuerySpec,
    execute_standard_list,
)
from app.common.listing.schemas import PaginationMetadata
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.access import has_level
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_occurrences import expand_board_event_occurrences
from app.systems.boards.event_purge_router import router as purge_router
from app.systems.boards.event_schemas import (
    EventArchiveFilter,
    EventCreate,
    EventDefinition,
    EventListRequest,
    EventListResponse,
    EventMutationResponse,
    EventPatch,
    EventResponse,
    EventRevisionWrite,
    EventSort,
    OccurrenceListResponse,
    OccurrenceRequest,
    OccurrenceResponse,
)
from app.systems.boards.models import Board, BoardStatus
from app.systems.boards.reminder_service import (
    TIMING_FIELDS,
    clear_pending_reminder_work,
    set_event_reminders,
    timings_by_event,
)
from app.systems.boards.router import _board_with_access

MAX_SERIES_CANDIDATES = 500
EVENT_FIELDS = (
    "title",
    "details",
    "location",
    "all_day",
    "start_date",
    "end_date",
    "start_at",
    "end_at",
    "timezone_name",
    "recurrence",
    "repeat_until",
)


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
router.include_router(purge_router)
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


EVENT_LIST_SPEC = ListQuerySpec(
    sort_fields={
        EventSort.CREATED_AT: cast(ColumnElement[Any], BoardEvent.created_at),
        EventSort.TITLE: cast(ColumnElement[Any], BoardEvent.title),
    },
    default_sort=EventSort.CREATED_AT,
    tie_breaker=cast(ColumnElement[Any], BoardEvent.id),
    search_fields=(cast(ColumnElement[str], BoardEvent.title),),
    deleted_field=None,
)


def _conflict(code: str, message: str, current_revision: int | None = None) -> HTTPException:
    detail: dict[str, str | int] = {"code": code, "message": message}
    if current_revision is not None:
        detail["current_revision"] = current_revision
    return HTTPException(status.HTTP_409_CONFLICT, detail=detail)


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail="Board event not found")


def _event(db: Session, board_id: UUID, event_id: UUID, *, lock: bool = False) -> BoardEvent:
    statement = select(BoardEvent).where(
        BoardEvent.id == event_id,
        BoardEvent.board_id == board_id,
        BoardEvent.is_deleted.is_(False),
        BoardEvent.deleted_at.is_(None),
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    event = db.scalar(statement)
    if event is None:
        raise _not_found()
    return event


def _definition(event: BoardEvent) -> EventDefinition:
    values = {key: getattr(event, key) for key in EVENT_FIELDS}
    values["links"] = event.links
    try:
        if not event.all_day:
            for key in ("start_at", "end_at"):
                value = values[key]
                if isinstance(value, datetime) and value.tzinfo is not None:
                    values[key] = value.astimezone(UTC)
        return EventDefinition.model_validate(values)
    except (OSError, OverflowError, TypeError, ValueError, ValidationError) as error:
        raise _conflict("event_invalid", "Stored Board event is invalid") from error


def _response(event: BoardEvent, board_revision: int, reminders: list[str]) -> EventResponse:
    definition = _definition(event)
    return EventResponse(
        id=event.id,
        board_id=event.board_id,
        author_id=event.author_id,
        **definition.model_dump(),
        reminders=reminders,
        archived=event.archived,
        revision=event.revision,
        board_revision=board_revision,
        created_at=event.created_at,
        updated_at=event.updated_at,
    )


def _mutation(event: BoardEvent, board: Board) -> EventMutationResponse:
    return EventMutationResponse(
        id=event.id, event_revision=event.revision, board_revision=board.revision
    )


def _check_board(board: Board, revision: int) -> None:
    if board.revision != revision:
        raise _conflict(
            "stale_board_revision", "Board changed; reload before saving", board.revision
        )
    if board.status != BoardStatus.ACTIVE:
        raise _conflict("board_archived", "Restore the Board before changing events")


def _check_event(event: BoardEvent, revision: int) -> None:
    if event.revision != revision:
        raise _conflict(
            "stale_event_revision", "Event changed; reload before saving", event.revision
        )


def _set_definition(event: BoardEvent, definition: EventDefinition) -> None:
    for key in EVENT_FIELDS:
        setattr(event, key, getattr(definition, key))
    event.links = [link.model_dump() for link in definition.links]


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict("event_conflict", "Unable to save Board event") from error
    except SQLAlchemyError:
        db.rollback()
        raise


def _changeable(db: Session, board: Board, event: BoardEvent, actor: User) -> None:
    """Authors change their own events; managers change every event."""

    if event.author_id != actor.id and not has_level(db, actor, board, AccessLevel.MANAGE):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Manage access required")


def event_responses(
    db: Session, events: list[BoardEvent], board_revision: int
) -> list[EventResponse]:
    reminders = timings_by_event(db, (event.id for event in events))
    return [_response(event, board_revision, reminders[event.id]) for event in events]


@router.get("/{board_id}/events/occurrences", response_model=OccurrenceListResponse)
def list_event_occurrences(
    board_id: UUID, actor: Reader, db: Database, params: Annotated[OccurrenceRequest, Query()]
) -> OccurrenceListResponse:
    board = _board_with_access(db, actor, board_id, AccessLevel.READ)
    statement = select(BoardEvent).where(
        BoardEvent.board_id == board.id,
        BoardEvent.is_deleted.is_(False),
        BoardEvent.deleted_at.is_(None),
        BoardEvent.archived.is_(False),
    )
    if params.search is not None:
        statement = statement.where(BoardEvent.title.icontains(params.search, autoescape=True))
    candidates = list(
        db.scalars(statement.order_by(BoardEvent.id).limit(MAX_SERIES_CANDIDATES + 1)).all()
    )
    if len(candidates) > MAX_SERIES_CANDIDATES:
        raise _conflict("event_candidate_limit", "Too many visible event series; archive events")
    items: list[OccurrenceResponse] = []
    for event, event_response in zip(
        candidates, event_responses(db, candidates, board.revision), strict=True
    ):
        definition = _definition(event)
        source = BoardEvent(id=event.id, **definition.model_dump())
        expanded = expand_board_event_occurrences(source, params.window_start, params.window_end)
        if expanded.truncated:
            raise _conflict("event_occurrence_limit", "Event occurrences exceed the window limit")
        items.extend(
            OccurrenceResponse(**asdict(item), event=event_response)
            for item in expanded.occurrences
        )
    items.sort(key=lambda item: (item.date, item.start, item.event_id, item.id))
    total = len(items)
    page = items[params.offset : params.offset + params.limit]
    return OccurrenceListResponse(
        items=page,
        board_revision=board.revision,
        pagination=PaginationMetadata(
            limit=params.limit,
            offset=params.offset,
            count=len(page),
            total=total,
            has_more=params.offset + len(page) < total,
        ),
    )


@router.get("/{board_id}/events", response_model=EventListResponse)
def list_board_events(
    board_id: UUID, actor: Reader, db: Database, params: Annotated[EventListRequest, Query()]
) -> EventListResponse:
    board = _board_with_access(db, actor, board_id, AccessLevel.READ)
    statement = select(BoardEvent).where(
        BoardEvent.board_id == board.id,
        BoardEvent.is_deleted.is_(False),
        BoardEvent.deleted_at.is_(None),
    )
    if params.archived != EventArchiveFilter.ALL:
        statement = statement.where(
            BoardEvent.archived.is_(params.archived == EventArchiveFilter.ARCHIVED)
        )
    result = execute_standard_list(db, statement, params, EVENT_LIST_SPEC)
    return EventListResponse(
        items=event_responses(db, list(result.items), board.revision),
        pagination=result.pagination,
        board_revision=board.revision,
    )


@router.post(
    "/{board_id}/events", response_model=EventMutationResponse, status_code=status.HTTP_201_CREATED
)
def create_board_event(
    board_id: UUID, payload: EventCreate, actor: Reader, db: Database, response: Response
) -> EventMutationResponse:
    board = _board_with_access(db, actor, board_id, AccessLevel.WRITE, lock=True)
    _check_board(board, payload.board_revision)
    count = db.scalar(
        select(func.count(BoardEvent.id)).where(
            BoardEvent.board_id == board.id,
            BoardEvent.is_deleted.is_(False),
            BoardEvent.deleted_at.is_(None),
            BoardEvent.archived.is_(False),
        )
    )
    if count is None or count >= MAX_SERIES_CANDIDATES:
        raise _conflict("event_limit_reached", "The Board has 500 active events")
    event = BoardEvent(org_id=board.org_id, board_id=board.id, author_id=actor.id)
    _set_definition(event, payload)
    db.add(event)
    db.flush()
    set_event_reminders(db, event, payload.reminders)
    board.revision += 1
    _commit(db)
    db.refresh(event)
    response.headers["Location"] = f"/api/boards/{board.id}/events/{event.id}"
    return _mutation(event, board)


@router.get("/{board_id}/events/{event_id}", response_model=EventResponse)
def read_board_event(board_id: UUID, event_id: UUID, actor: Reader, db: Database) -> EventResponse:
    board = _board_with_access(db, actor, board_id, AccessLevel.READ)
    return event_responses(db, [_event(db, board.id, event_id)], board.revision)[0]


@router.patch("/{board_id}/events/{event_id}", response_model=EventMutationResponse)
def update_board_event(
    board_id: UUID, event_id: UUID, payload: EventPatch, actor: Reader, db: Database
) -> EventMutationResponse:
    board = _board_with_access(db, actor, board_id, AccessLevel.WRITE, lock=True)
    _check_board(board, payload.board_revision)
    event = _event(db, board.id, event_id, lock=True)
    _changeable(db, board, event, actor)
    _check_event(event, payload.event_revision)
    if event.archived:
        raise _conflict("event_archived", "Restore the event before editing it")
    values = _definition(event).model_dump()
    values.update(
        payload.model_dump(
            exclude_unset=True, exclude={"board_revision", "event_revision", "reminders"}
        )
    )
    try:
        definition = EventDefinition.model_validate(values)
        definition.require_bounded_occurrences()
    except ValueError as error:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": "event_invalid", "message": "Event fields are invalid"},
        ) from error
    previous = tuple(getattr(event, key) for key in TIMING_FIELDS)
    _set_definition(event, definition)
    if tuple(getattr(event, key) for key in TIMING_FIELDS) != previous:
        clear_pending_reminder_work(db, event.id)
    if payload.reminders is not None:
        set_event_reminders(db, event, payload.reminders)
    event.revision += 1
    board.revision += 1
    _commit(db)
    return _mutation(event, board)


def _lifecycle_event(
    db: Session, board_id: UUID, event_id: UUID, actor: User, payload: EventRevisionWrite
) -> tuple[Board, BoardEvent]:
    board = _board_with_access(db, actor, board_id, AccessLevel.WRITE, lock=True)
    _check_board(board, payload.board_revision)
    event = _event(db, board.id, event_id, lock=True)
    _changeable(db, board, event, actor)
    _check_event(event, payload.event_revision)
    return board, event


@router.post("/{board_id}/events/{event_id}/archive", response_model=EventMutationResponse)
def archive_board_event(
    board_id: UUID, event_id: UUID, payload: EventRevisionWrite, actor: Reader, db: Database
) -> EventMutationResponse:
    board, event = _lifecycle_event(db, board_id, event_id, actor, payload)
    if event.archived:
        raise _conflict("event_archived", "The event is already archived")
    event.archived = True
    clear_pending_reminder_work(db, event.id)
    event.revision += 1
    board.revision += 1
    _commit(db)
    return _mutation(event, board)


@router.post("/{board_id}/events/{event_id}/restore", response_model=EventMutationResponse)
def restore_board_event(
    board_id: UUID, event_id: UUID, payload: EventRevisionWrite, actor: Reader, db: Database
) -> EventMutationResponse:
    board, event = _lifecycle_event(db, board_id, event_id, actor, payload)
    if not event.archived:
        raise _conflict("event_not_archived", "Archive the event before restoring it")
    event.archived = False
    event.revision += 1
    board.revision += 1
    _commit(db)
    return _mutation(event, board)
