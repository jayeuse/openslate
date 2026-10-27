"""Objective checklists: writers add, tick, rename, order and remove items."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.kanban_models import BoardCard, BoardCardChecklistItem
from app.systems.boards.kanban_schemas import (
    ChecklistCreate,
    ChecklistItemResponse,
    ChecklistItems,
    ChecklistOrder,
    ChecklistPatch,
    RevisionWrite,
)
from app.systems.boards.kanban_service import (
    MAX_CHECKLIST_ITEMS,
    card,
    check_revision,
    checklist_items,
    commit,
    kanban_error,
    not_found,
    write_board,
)
from app.systems.boards.models import Board


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(
    prefix="/boards", tags=["board kanban"], dependencies=[Depends(_private_cache)]
)
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


def _objective(db: Session, board: Board, card_id: UUID) -> BoardCard:
    item = card(db, board.id, card_id, lock=True)
    if item.kind != "objective":
        raise kanban_error("checklist_objectives_only", "Only objectives have a checklist")
    if item.archived_at is not None:
        raise kanban_error("card_archived", "Restore the card before changing it")
    return item


def _item(db: Session, board: Board, item_id: UUID) -> BoardCardChecklistItem:
    row = db.scalar(
        select(BoardCardChecklistItem)
        .where(
            BoardCardChecklistItem.id == item_id,
            BoardCardChecklistItem.board_id == board.id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise not_found("Checklist item")
    _objective(db, board, row.card_id)
    return row


@router.post(
    "/{board_id}/cards/{card_id}/checklist",
    response_model=ChecklistItemResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_checklist_item(
    board_id: UUID, card_id: UUID, payload: ChecklistCreate, actor: Reader, db: Database
) -> ChecklistItemResponse:
    board = write_board(db, actor, board_id, AccessLevel.WRITE)
    item = _objective(db, board, card_id)
    existing = checklist_items(db, item.id)
    if len(existing) >= MAX_CHECKLIST_ITEMS:
        raise kanban_error("checklist_limit", "A card has at most 50 checklist items")
    row = BoardCardChecklistItem(
        org_id=board.org_id, board_id=board.id, card_id=item.id, text=payload.text,
        position=max((entry.position for entry in existing), default=-1) + 1,
    )
    db.add(row)
    commit(db, "checklist_conflict", "Unable to add the item; reload the card")
    db.refresh(row)
    return ChecklistItemResponse.model_validate(row)


@router.patch("/{board_id}/checklist/{item_id}", response_model=ChecklistItemResponse)
def update_checklist_item(
    board_id: UUID, item_id: UUID, payload: ChecklistPatch, actor: Reader, db: Database
) -> ChecklistItemResponse:
    board = write_board(db, actor, board_id, AccessLevel.WRITE)
    row = _item(db, board, item_id)
    check_revision(row, payload.revision, "stale_checklist_revision")
    if payload.text is not None:
        row.text = payload.text
    if payload.done is not None:
        row.done = payload.done
    if payload.text is not None or payload.done is not None:
        row.revision += 1
    commit(db, "checklist_conflict", "Unable to save the item; reload the card")
    db.refresh(row)
    return ChecklistItemResponse.model_validate(row)


@router.delete("/{board_id}/checklist/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_checklist_item(
    board_id: UUID, item_id: UUID, payload: RevisionWrite, actor: Reader, db: Database
) -> None:
    board = write_board(db, actor, board_id, AccessLevel.WRITE)
    row = _item(db, board, item_id)
    check_revision(row, payload.revision, "stale_checklist_revision")
    db.delete(row)
    commit(db, "checklist_conflict", "Unable to remove the item; reload the card")


@router.put("/{board_id}/cards/{card_id}/checklist/order", response_model=ChecklistItems)
def order_checklist(
    board_id: UUID, card_id: UUID, payload: ChecklistOrder, actor: Reader, db: Database
) -> ChecklistItems:
    """Set the order of every item; the list must name each item exactly once."""

    board = write_board(db, actor, board_id, AccessLevel.WRITE)
    item = _objective(db, board, card_id)
    rows = {
        row.id: row
        for row in db.scalars(
            select(BoardCardChecklistItem)
            .where(BoardCardChecklistItem.card_id == item.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    }
    if set(payload.item_ids) != rows.keys():
        raise kanban_error("checklist_order_stale", "The checklist changed; reload the card")
    for row in rows.values():
        row.position += 10_000_000
    db.flush()
    for position, identity in enumerate(payload.item_ids):
        rows[identity].position = position
    commit(db, "checklist_conflict", "Unable to order the checklist; reload the card")
    return ChecklistItems(
        items=[ChecklistItemResponse.model_validate(rows[identity])
               for identity in payload.item_ids]
    )
