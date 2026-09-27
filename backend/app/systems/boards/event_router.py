"""Board event-series and occurrence routes; not mounted in the application yet."""

from dataclasses import asdict
from datetime import UTC, datetime
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import ValidationError
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user, require_non_guest
from app.common.listing import (
    ListQuerySpec,
    execute_standard_list,
)
from app.common.listing.schemas import PaginationMetadata
from app.core.database import get_db
from app.systems.access.identity.eligibility import identity_eligible_clause
from app.systems.access.policy.scope import department_reader_clause
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.models import User, UserStatus
from app.systems.boards.access import can_access_board
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_occurrences import expand_board_event_occurrences
from app.systems.boards.event_schemas import (
    EventArchiveFilter,
    EventAudience,
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
from app.systems.boards.models import Board, BoardGrant, BoardPermission, BoardStatus
from app.systems.boards.reminder_service import (
    cancel_event_reminders,
    delete_event_reminders,
    reconcile_event_reminders,
    snapshot_event_timing,
)
from app.systems.boards.router import _board_with_access
from app.systems.sandbox.departments.models import Department

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
Reader = Annotated[User, Depends(get_current_user)]
Writer = Annotated[User, Depends(require_non_guest)]
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


def _audience_clause(actor: User) -> ColumnElement[bool]:
    """Everyone, the author, one user, or the readers of one department."""
    return or_(
        and_(
            BoardEvent.audience_kind == "everyone",
            BoardEvent.audience_user_id.is_(None),
            BoardEvent.audience_department_id.is_(None),
        ),
        and_(
            BoardEvent.audience_kind == "author",
            BoardEvent.author_id == actor.id,
            BoardEvent.audience_user_id.is_(None),
            BoardEvent.audience_department_id.is_(None),
        ),
        and_(
            BoardEvent.audience_kind == "user",
            BoardEvent.audience_user_id == actor.id,
            BoardEvent.audience_department_id.is_(None),
        ),
        and_(
            BoardEvent.audience_kind == "department",
            BoardEvent.audience_user_id.is_(None),
            department_reader_clause(actor, BoardEvent.audience_department_id),
        ),
    )


def _event(
    db: Session, board_id: UUID, event_id: UUID, actor: User, *, lock: bool = False,
    allow_author: bool = False,
) -> BoardEvent:
    statement = select(BoardEvent).where(
        BoardEvent.id == event_id,
        BoardEvent.board_id == board_id,
        BoardEvent.is_deleted.is_(False),
        BoardEvent.deleted_at.is_(None),
        or_(_audience_clause(actor), BoardEvent.author_id == actor.id)
        if allow_author
        else _audience_clause(actor),
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    event = db.scalar(statement)
    if event is None:
        raise _not_found()
    return event


def _audience(event: BoardEvent) -> EventAudience:
    return EventAudience(
        kind=event.audience_kind,
        user_id=event.audience_user_id,
        department_id=event.audience_department_id,
    )


def _definition(event: BoardEvent) -> EventDefinition:
    values = {key: getattr(event, key) for key in EVENT_FIELDS}
    values["links"] = event.links
    values["audience"] = _audience(event)
    try:
        if not event.all_day:
            for key in ("start_at", "end_at"):
                value = values[key]
                if isinstance(value, datetime) and value.tzinfo is not None:
                    values[key] = value.astimezone(UTC)
        return EventDefinition.model_validate(values)
    except (OSError, OverflowError, TypeError, ValueError, ValidationError) as error:
        raise _conflict("event_invalid", "Stored Board event is invalid") from error


def _response(event: BoardEvent, board_revision: int) -> EventResponse:
    definition = _definition(event)
    return EventResponse(
        id=event.id,
        board_id=event.board_id,
        author_id=event.author_id,
        **definition.model_dump(),
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


def _validate_target(db: Session, audience: EventAudience) -> None:
    if audience.kind == "user":
        target = db.scalar(
            select(User.id)
            .where(
                User.id == audience.user_id,
                User.status == UserStatus.ACTIVE.value,
                User.is_deleted.is_(False),
                User.deleted_at.is_(None),
                identity_eligible_clause(),
                established_user_clause(),
            )
            .with_for_update(of=User)
        )
    elif audience.kind == "department":
        target = db.scalar(
            select(Department.id)
            .where(
                Department.id == audience.department_id,
                Department.is_deleted.is_(False),
                Department.deleted_at.is_(None),
            )
            .with_for_update()
        )
    else:
        return
    if target is None:
        raise _conflict("audience_unavailable", "The selected audience is unavailable")


def _set_definition(event: BoardEvent, definition: EventDefinition) -> None:
    for key in EVENT_FIELDS:
        setattr(event, key, getattr(definition, key))
    event.links = [link.model_dump() for link in definition.links]
    event.audience_kind = definition.audience.kind
    event.audience_user_id = definition.audience.user_id
    event.audience_department_id = definition.audience.department_id


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict("event_conflict", "Unable to save Board event") from error
    except SQLAlchemyError:
        db.rollback()
        raise


def _manager(db: Session, board: Board, actor: User) -> bool:
    grants = db.scalars(
        select(BoardGrant).where(
            BoardGrant.board_id == board.id,
            BoardGrant.is_deleted.is_(False),
            BoardGrant.deleted_at.is_(None),
        )
    ).all()
    return can_access_board(board, actor, BoardPermission.MANAGE, grants)


@router.get("/{board_id}/events/occurrences", response_model=OccurrenceListResponse)
def list_event_occurrences(
    board_id: UUID, actor: Reader, db: Database, params: Annotated[OccurrenceRequest, Query()]
) -> OccurrenceListResponse:
    board = _board_with_access(db, actor, board_id, BoardPermission.VIEW)
    statement = select(BoardEvent).where(
        BoardEvent.board_id == board.id,
        BoardEvent.is_deleted.is_(False),
        BoardEvent.deleted_at.is_(None),
        BoardEvent.archived.is_(False),
        _audience_clause(actor),
    )
    if params.search is not None:
        statement = statement.where(BoardEvent.title.icontains(params.search, autoescape=True))
    candidates = db.scalars(
        statement.order_by(BoardEvent.id).limit(MAX_SERIES_CANDIDATES + 1)
    ).all()
    if len(candidates) > MAX_SERIES_CANDIDATES:
        raise _conflict("event_candidate_limit", "Too many visible event series; archive events")
    items: list[OccurrenceResponse] = []
    for event in candidates:
        event_response = _response(event, board.revision)
        definition = _definition(event)
        source = BoardEvent(id=event.id, **definition.model_dump(exclude={"audience"}))
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
    board = _board_with_access(db, actor, board_id, BoardPermission.VIEW)
    statement = select(BoardEvent).where(
        BoardEvent.board_id == board.id,
        BoardEvent.is_deleted.is_(False),
        BoardEvent.deleted_at.is_(None),
        _audience_clause(actor),
    )
    if params.archived != EventArchiveFilter.ALL:
        statement = statement.where(
            BoardEvent.archived.is_(params.archived == EventArchiveFilter.ARCHIVED)
        )
    result = execute_standard_list(db, statement, params, EVENT_LIST_SPEC)
    return EventListResponse(
        items=[_response(row, board.revision) for row in result.items],
        pagination=result.pagination,
        board_revision=board.revision,
    )


@router.post(
    "/{board_id}/events", response_model=EventMutationResponse, status_code=status.HTTP_201_CREATED
)
def create_board_event(
    board_id: UUID, payload: EventCreate, actor: Writer, db: Database, response: Response
) -> EventMutationResponse:
    board = _board_with_access(db, actor, board_id, BoardPermission.EDIT, lock=True)
    _check_board(board, payload.board_revision)
    _validate_target(db, payload.audience)
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
    event = BoardEvent(board_id=board.id, author_id=actor.id)
    _set_definition(event, payload)
    db.add(event)
    board.revision += 1
    _commit(db)
    db.refresh(event)
    response.headers["Location"] = f"/api/boards/{board.id}/events/{event.id}"
    return _mutation(event, board)


@router.get("/{board_id}/events/{event_id}", response_model=EventResponse)
def read_board_event(board_id: UUID, event_id: UUID, actor: Reader, db: Database) -> EventResponse:
    board = _board_with_access(db, actor, board_id, BoardPermission.VIEW)
    return _response(_event(db, board.id, event_id, actor, allow_author=True), board.revision)


@router.patch("/{board_id}/events/{event_id}", response_model=EventMutationResponse)
def update_board_event(
    board_id: UUID, event_id: UUID, payload: EventPatch, actor: Writer, db: Database
) -> EventMutationResponse:
    board = _board_with_access(db, actor, board_id, BoardPermission.EDIT, lock=True)
    _check_board(board, payload.board_revision)
    manager = _manager(db, board, actor)
    event = _event(db, board.id, event_id, actor, lock=True, allow_author=True)
    if event.author_id != actor.id and not manager:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Manage access required")
    _check_event(event, payload.event_revision)
    if event.archived:
        raise _conflict("event_archived", "Restore the event before editing it")
    values = _definition(event).model_dump()
    values.update(
        payload.model_dump(exclude_unset=True, exclude={"board_revision", "event_revision"})
    )
    try:
        definition = EventDefinition.model_validate(values)
    except ValidationError as error:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": "event_invalid", "message": "Event fields are invalid"},
        ) from error
    _validate_target(db, definition.audience)
    previous_timing = snapshot_event_timing(event)
    _set_definition(event, definition)
    reconcile_event_reminders(db, event, previous_timing)
    event.revision += 1
    board.revision += 1
    _commit(db)
    return _mutation(event, board)


def _lifecycle_event(
    db: Session, board_id: UUID, event_id: UUID, actor: User, payload: EventRevisionWrite
) -> tuple[Board, BoardEvent]:
    board = _board_with_access(db, actor, board_id, BoardPermission.MANAGE, lock=True)
    _check_board(board, payload.board_revision)
    event = _event(db, board.id, event_id, actor, lock=True, allow_author=True)
    _check_event(event, payload.event_revision)
    return board, event


@router.post("/{board_id}/events/{event_id}/archive", response_model=EventMutationResponse)
def archive_board_event(
    board_id: UUID, event_id: UUID, payload: EventRevisionWrite, actor: Writer, db: Database
) -> EventMutationResponse:
    board, event = _lifecycle_event(db, board_id, event_id, actor, payload)
    if event.archived:
        raise _conflict("event_archived", "The event is already archived")
    event.archived = True
    cancel_event_reminders(db, event.id)
    event.revision += 1
    board.revision += 1
    _commit(db)
    return _mutation(event, board)


@router.post("/{board_id}/events/{event_id}/restore", response_model=EventMutationResponse)
def restore_board_event(
    board_id: UUID, event_id: UUID, payload: EventRevisionWrite, actor: Writer, db: Database
) -> EventMutationResponse:
    board, event = _lifecycle_event(db, board_id, event_id, actor, payload)
    if not event.archived:
        raise _conflict("event_not_archived", "Archive the event before restoring it")
    event.archived = False
    event.revision += 1
    board.revision += 1
    _commit(db)
    return _mutation(event, board)


@router.delete("/{board_id}/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_board_event(
    board_id: UUID, event_id: UUID, payload: EventRevisionWrite, actor: Writer, db: Database
) -> None:
    board, event = _lifecycle_event(db, board_id, event_id, actor, payload)
    if not event.archived:
        raise _conflict("event_not_archived", "Archive the event before deleting it")
    from app.systems.boards.attachment_service import delete_event_attachments
    from app.systems.boards.record_link_service import delete_content_links

    delete_event_attachments(db, event.id)
    delete_content_links(db, "event", event.id)
    delete_event_reminders(db, event.id)
    db.delete(event)
    board.revision += 1
    _commit(db)
