"""My calendar's "My cards · Due" (BR58): the viewer's due cards on every Board they read.

One read across Boards, never one per Board: a card is listed when it is active, on an
active stage of an active Board the viewer reads now, assigned to the viewer, and due
inside the inclusive window. Record cards carry the viewer's own summary or a lock
(``card_summary``), exactly as the Board's Kanban shows them.
"""

from datetime import date
from typing import Annotated, Literal, Self

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.common.listing.schemas import PaginationMetadata
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.boards.access import visible_board_clause
from app.systems.boards.event_schemas import MAX_WINDOW_DAYS, OccurrenceBoard
from app.systems.boards.kanban_models import BoardCard, BoardStage
from app.systems.boards.kanban_schemas import CardResponse
from app.systems.boards.kanban_service import card_responses
from app.systems.boards.models import Board, BoardScope, BoardStatus


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(
    prefix="/boards", tags=["board kanban"], dependencies=[Depends(_private_cache)]
)
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


class DueCardRequest(BaseModel):
    """``from`` and ``to`` are inclusive dates, at most 42 days apart.

    ``assignee`` is always the viewer (``me``); it is accepted for the spec's address.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    assignee: Literal["me"] = "me"
    due_from: date = Field(alias="from")
    due_to: date = Field(alias="to")
    limit: int = Field(default=25, ge=1, le=100)
    offset: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def bounded_window(self) -> Self:
        if (
            self.due_to < self.due_from
            or (self.due_to - self.due_from).days + 1 > MAX_WINDOW_DAYS
        ):
            raise ValueError("Choose an inclusive window of at most 42 days")
        return self


class DueCardResponse(CardResponse):
    board: OccurrenceBoard


class DueCardListResponse(BaseModel):
    items: list[DueCardResponse]
    pagination: PaginationMetadata


@router.get("/cards/due", response_model=DueCardListResponse)
def list_my_due_cards(
    actor: Reader, db: Database, params: Annotated[DueCardRequest, Query()]
) -> DueCardListResponse:
    """Sorted by due date, Board, rank and ID; one page of the merged list."""

    statement = (
        select(BoardCard, Board)
        .join(Board, Board.id == BoardCard.board_id)
        .join(BoardStage, BoardStage.id == BoardCard.stage_id)
        .where(
            BoardCard.assignee_id == actor.id,
            BoardCard.due_on >= params.due_from,
            BoardCard.due_on <= params.due_to,
            BoardCard.archived_at.is_(None),
            BoardCard.is_deleted.is_(False),
            BoardStage.archived_at.is_(None),
            BoardStage.is_deleted.is_(False),
            Board.status == BoardStatus.ACTIVE.value,
            Board.is_deleted.is_(False),
            Board.deleted_at.is_(None),
            visible_board_clause(db, actor),
        )
    )
    total = db.scalar(select(func.count()).select_from(statement.subquery())) or 0
    rows = db.execute(
        statement.order_by(BoardCard.due_on, BoardCard.board_id, BoardCard.rank, BoardCard.id)
        .limit(params.limit)
        .offset(params.offset)
    ).tuples().all()
    cards = card_responses(db, actor, [card for card, _ in rows])
    items = [
        DueCardResponse(
            **response.model_dump(),
            board=OccurrenceBoard(
                id=board.id,
                name=board.name,
                scope=BoardScope(board.scope),
                department_id=board.department_id,
            ),
        )
        for response, (_, board) in zip(cards, rows, strict=True)
    ]
    return DueCardListResponse(
        items=items,
        pagination=PaginationMetadata(
            limit=params.limit,
            offset=params.offset,
            count=len(items),
            total=total,
            has_more=params.offset + len(items) < total,
        ),
    )
