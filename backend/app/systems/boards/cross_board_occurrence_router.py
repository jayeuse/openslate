"""My calendar: event occurrences across every active Board the reader can read.

The limits of the per-Board read apply to each Board alone and never fail the read:
a Board over a limit adds no items and reports its status. A requested Board that is
unknown, archived, or not readable comes back ``unavailable`` with nothing else, so
the response never tells those three apart.
"""

from collections.abc import Sequence
from dataclasses import asdict
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.common.listing.schemas import PaginationMetadata
from app.systems.boards.access import visible_board_clause
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import (
    MAX_SERIES_CANDIDATES,
    Database,
    Reader,
    expand_candidates,
    summary,
)
from app.systems.boards.event_schemas import (
    BoardOccurrenceState,
    BoardOccurrenceStatus,
    CrossBoardOccurrenceListResponse,
    CrossBoardOccurrenceRequest,
    CrossBoardOccurrenceResponse,
    OccurrenceBoard,
)
from app.systems.boards.models import Board, BoardScope, BoardStatus
from app.systems.boards.reminder_service import timings_by_event


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])


def _candidates(
    db: Session, board_ids: Sequence[UUID], search: str | None
) -> dict[UUID, list[BoardEvent]]:
    """Each Board's first ``MAX_SERIES_CANDIDATES + 1`` events by id, in one query."""

    found: dict[UUID, list[BoardEvent]] = {board_id: [] for board_id in board_ids}
    if not board_ids:
        return found
    position = func.row_number().over(partition_by=BoardEvent.board_id, order_by=BoardEvent.id)
    ranked = select(BoardEvent.id.label("event_id"), position.label("position")).where(
        BoardEvent.board_id.in_(board_ids),
        BoardEvent.is_deleted.is_(False),
        BoardEvent.deleted_at.is_(None),
        BoardEvent.archived.is_(False),
    )
    if search is not None:
        ranked = ranked.where(BoardEvent.title.icontains(search, autoescape=True))
    window = ranked.subquery()
    statement = (
        select(BoardEvent)
        .join(window, window.c.event_id == BoardEvent.id)
        .where(window.c.position <= MAX_SERIES_CANDIDATES + 1)
        .order_by(BoardEvent.board_id, BoardEvent.id)
    )
    for event in db.scalars(statement):
        found[event.board_id].append(event)
    return found


def _unavailable(board_id: UUID) -> BoardOccurrenceState:
    return BoardOccurrenceState(
        board_id=board_id,
        revision=None,
        status=BoardOccurrenceStatus.UNAVAILABLE,
        next_occurrence=None,
    )


def _limited(board: Board, status: BoardOccurrenceStatus) -> BoardOccurrenceState:
    return BoardOccurrenceState(
        board_id=board.id, revision=board.revision, status=status, next_occurrence=None
    )


@router.get("/occurrences", response_model=CrossBoardOccurrenceListResponse)
def list_cross_board_occurrences(
    actor: Reader, db: Database, params: Annotated[CrossBoardOccurrenceRequest, Query()]
) -> CrossBoardOccurrenceListResponse:
    requested = list(dict.fromkeys(params.board_id))
    statement = select(Board).where(
        Board.is_deleted.is_(False),
        Board.deleted_at.is_(None),
        Board.status == BoardStatus.ACTIVE.value,
        visible_board_clause(db, actor),
    )
    if requested:
        statement = statement.where(Board.id.in_(requested))
    boards = {board.id: board for board in db.scalars(statement.order_by(Board.id))}
    candidates = _candidates(db, list(boards), params.search)
    reminders = timings_by_event(
        db, (event.id for events in candidates.values() for event in events)
    )

    states: list[BoardOccurrenceState] = []
    items: list[CrossBoardOccurrenceResponse] = []
    for board_id in requested or list(boards):
        board = boards.get(board_id)
        if board is None:
            states.append(_unavailable(board_id))
            continue
        events = candidates[board.id]
        if len(events) > MAX_SERIES_CANDIDATES:
            states.append(_limited(board, BoardOccurrenceStatus.CANDIDATE_LIMIT))
            continue
        try:
            expanded = expand_candidates(
                events, reminders, board.revision, params.window_start, params.window_end
            )
        except HTTPException:
            # A stored event that is invalid (``event_invalid``) hides its Board only.
            states.append(_unavailable(board.id))
            continue
        if expanded is None:
            states.append(_limited(board, BoardOccurrenceStatus.OCCURRENCE_LIMIT))
            continue
        states.append(
            BoardOccurrenceState(
                board_id=board.id,
                revision=board.revision,
                status=BoardOccurrenceStatus.OK,
                next_occurrence=summary(expanded.next_occurrence),
            )
        )
        mark = OccurrenceBoard(
            id=board.id,
            name=board.name,
            scope=BoardScope(board.scope),
            department_id=board.department_id,
        )
        items.extend(
            CrossBoardOccurrenceResponse(**asdict(item), event=event_response, board=mark)
            for item, event_response in expanded.occurrences
        )

    items.sort(key=lambda item: (item.date, item.start, str(item.board.id), item.event_id, item.id))
    total = len(items)
    page = items[params.offset : params.offset + params.limit]
    return CrossBoardOccurrenceListResponse(
        items=page,
        boards=states,
        pagination=PaginationMetadata(
            limit=params.limit,
            offset=params.offset,
            count=len(page),
            total=total,
            has_more=params.offset + len(page) < total,
        ),
    )
