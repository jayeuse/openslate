"""Record cards of a purged Record or module: listed and removed, never a blocker.

A record card only points at its Record; the Board keeps working without it. A
Record, module or Department purge therefore lists each card that points at a
purged Record or module (with its labels and checklist items) and removes them in
the same transaction. Cards on the purged Department's own Boards are inventoried
with those Boards instead. The cards' Boards are locked first (the Board lock order).
"""

from collections.abc import Callable
from typing import Any
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.systems.boards.kanban_models import BoardCard, BoardCardChecklistItem, BoardCardLabel
from app.systems.sandbox.lifecycle.planning_scope import row_state
from app.systems.sandbox.lifecycle.schemas import LifecycleRowState

# Deletion order: a card's labels and checklist go before the card.
CARD_ROW_MODELS: tuple[tuple[str, type[Any]], ...] = (
    ("board_card_labels", BoardCardLabel),
    ("board_card_checklist_items", BoardCardChecklistItem),
    ("board_cards", BoardCard),
)
_IDENTITY = {
    "board_cards": ("board_id", "kind", "record_id", "module_id"),
    "board_card_labels": ("board_id", "card_id", "label_id"),
    "board_card_checklist_items": ("board_id", "card_id"),
}


def load_board_card_purge_dependencies(
    db: Session,
    record_ids: list[UUID],
    module_ids: list[UUID],
    cascaded_board_ids: tuple[UUID, ...],
    fingerprint: Callable[[object], str],
) -> tuple[list[LifecycleRowState], dict[str, tuple[UUID, ...]], set[UUID]]:
    """Rows to list, IDs to lock and remove, and the Boards to lock first."""

    targets = []
    if record_ids:
        targets.append(BoardCard.record_id.in_(record_ids))
    if module_ids:
        targets.append(BoardCard.module_id.in_(module_ids))
    if not targets:
        return [], {key: () for key, _ in CARD_ROW_MODELS}, set()
    statement = select(BoardCard).where(or_(*targets)).order_by(BoardCard.id)
    if cascaded_board_ids:
        statement = statement.where(BoardCard.board_id.not_in(cascaded_board_ids))
    cards = list(db.scalars(statement))
    card_ids = [item.id for item in cards]
    found: dict[str, list[Any]] = {"board_cards": cards}
    for key, model in CARD_ROW_MODELS[:2]:
        found[key] = (
            list(db.scalars(select(model).where(model.card_id.in_(card_ids)).order_by(model.id)))
            if card_ids
            else []
        )
    rows: list[LifecycleRowState] = []
    for key, _ in CARD_ROW_MODELS:
        for row in found[key]:
            state = row_state(key, row)
            state.state_fingerprint = fingerprint(
                {name: getattr(row, name) for name in _IDENTITY[key]}
            )
            rows.append(state)
    return (
        rows,
        {key: tuple(row.id for row in found[key]) for key, _ in CARD_ROW_MODELS},
        {item.board_id for item in cards},
    )
