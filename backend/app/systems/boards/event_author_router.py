"""Creator-only Event discovery routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.dependencies import require_legacy_capability
from app.common.listing import execute_standard_list
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.access.users.permissions import Capability
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import EVENT_LIST_SPEC, _response
from app.systems.boards.event_schemas import (
    EventArchiveFilter,
    EventListRequest,
    EventListResponse,
)
from app.systems.boards.models import BoardPermission
from app.systems.boards.router import _board_with_access

router = APIRouter(prefix="/boards", tags=["boards"])
Reader = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_READ))]
Database = Annotated[Session, Depends(get_db)]


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


@router.get(
    "/{board_id}/events/mine",
    response_model=EventListResponse,
    dependencies=[
        Depends(_private_cache),
        Depends(require_legacy_capability(Capability.RECORDS_WRITE)),
    ],
)
def list_my_board_events(
    board_id: UUID,
    actor: Reader,
    db: Database,
    params: Annotated[EventListRequest, Query()],
) -> EventListResponse:
    """List only Events created by the caller, regardless of recipient audience."""
    board = _board_with_access(db, actor, board_id, BoardPermission.EDIT)
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
        items=[_response(row, board.revision) for row in result.items],
        pagination=result.pagination,
        board_revision=board.revision,
    )
