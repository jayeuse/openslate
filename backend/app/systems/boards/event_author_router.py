"""The events that the caller wrote on a Board."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.common.listing import execute_standard_list
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import EVENT_LIST_SPEC, event_responses
from app.systems.boards.event_schemas import (
    EventArchiveFilter,
    EventListRequest,
    EventListResponse,
)
from app.systems.boards.router import _board_with_access

router = APIRouter(prefix="/boards", tags=["boards"])
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


@router.get(
    "/{board_id}/events/mine",
    response_model=EventListResponse,
    dependencies=[Depends(_private_cache)],
)
def list_my_board_events(
    board_id: UUID,
    actor: Reader,
    db: Database,
    params: Annotated[EventListRequest, Query()],
) -> EventListResponse:
    """List only the events that the caller wrote on this Board."""
    board = _board_with_access(db, actor, board_id, AccessLevel.WRITE)
    statement = select(BoardEvent).where(
        BoardEvent.board_id == board.id,
        BoardEvent.author_id == actor.id,
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
