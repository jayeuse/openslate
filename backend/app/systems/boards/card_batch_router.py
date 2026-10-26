"""The Gantt's Save changes: several card date changes, each with its own result.

The caller needs write on the Board (else 403, or 404 when hidden). Each item is
``updated``, ``stale`` (its revision changed) or ``forbidden`` (no active card with
that ID on this Board, or a record card the caller sees locked). One commit holds
every updated item.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.card_summary import readable_records
from app.systems.boards.kanban_models import BoardCard
from app.systems.boards.kanban_schemas import (
    CardBatchDates,
    CardBatchDatesResponse,
    CardDatesForbidden,
    CardDatesResult,
    CardDatesStale,
    CardDatesUpdated,
)
from app.systems.boards.kanban_service import commit, write_board


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(
    prefix="/boards", tags=["board kanban"], dependencies=[Depends(_private_cache)]
)
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


@router.post("/{board_id}/cards/batch-dates", response_model=CardBatchDatesResponse)
def batch_card_dates(
    board_id: UUID, payload: CardBatchDates, actor: Reader, db: Database
) -> CardBatchDatesResponse:
    board = write_board(db, actor, board_id, AccessLevel.WRITE)
    cards: dict[UUID, BoardCard] = {
        item.id: item
        for item in db.scalars(
            select(BoardCard)
            .where(
                BoardCard.board_id == board.id,
                BoardCard.id.in_(sorted(item.card_id for item in payload.items)),
                BoardCard.archived_at.is_(None),
                BoardCard.is_deleted.is_(False),
            )
            .order_by(BoardCard.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    }
    readable = readable_records(db, actor, cards.values())
    results: list[CardDatesResult] = []
    for change in payload.items:
        item = cards.get(change.card_id)
        if item is None or (
            item.record_id is not None
            and (item.record_id, item.module_id) not in readable
        ):
            results.append(CardDatesForbidden(card_id=change.card_id))
            continue
        if item.revision != change.revision:
            results.append(CardDatesStale(card_id=change.card_id))
            continue
        if (item.start_on, item.due_on) != (change.start_on, change.due_on):
            item.start_on, item.due_on = change.start_on, change.due_on
            item.revision += 1
        results.append(
            CardDatesUpdated(
                card_id=item.id, revision=item.revision,
                start_on=item.start_on, due_on=item.due_on,
            )
        )
    commit(db, "card_conflict", "Unable to save the dates; reload the Board")
    return CardBatchDatesResponse(results=results)
