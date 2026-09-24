"""Retained Board Record shortcuts that block physical Record purge."""

from collections.abc import Callable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.boards.models import BoardRecordPlacement
from app.systems.sandbox.lifecycle.planning_scope import row_state
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleRowState,
)


def load_board_placement_purge_dependencies(
    db: Session,
    record_ids: list[UUID],
    fingerprint: Callable[[object], str],
) -> tuple[list[LifecycleRowState], list[LifecycleBlocker], tuple[UUID, ...], set[UUID]]:
    placements = (
        list(
            db.scalars(
                select(BoardRecordPlacement)
                .where(BoardRecordPlacement.record_id.in_(record_ids))
                .order_by(BoardRecordPlacement.id)
            )
        )
        if record_ids
        else []
    )
    rows: list[LifecycleRowState] = []
    blockers: list[LifecycleBlocker] = []
    for placement in placements:
        state = row_state("board_record_placements", placement)
        state.state_fingerprint = fingerprint(
            {"board_id": placement.board_id, "record_id": placement.record_id}
        )
        rows.append(state)
        blockers.append(
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY,
                entity_type="board_record_placements",
                entity_id=placement.id,
                detail=(
                    "Remove this Record link from its Board or permanently delete the Board "
                    "before purging the source Record"
                ),
                conflicting_entity_type="boards",
                conflicting_entity_id=placement.board_id,
            )
        )
    return (
        rows,
        blockers,
        tuple(item.id for item in placements),
        {item.board_id for item in placements},
    )
