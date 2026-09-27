"""Retained Board event audiences that block physical Department purge."""

from collections.abc import Callable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.boards.event_models import BoardEvent
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.planning_scope import row_state
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleRowState,
)


def load_board_event_purge_dependencies(
    db: Session,
    department_ids: list[UUID],
    departments_by_id: dict[UUID, Department],
    fingerprint: Callable[[object], str],
) -> tuple[list[LifecycleRowState], list[LifecycleBlocker], dict[str, tuple[UUID, ...]]]:
    """Include active, archived, and soft-deleted events regardless of Board parent."""

    events = (
        list(
            db.scalars(
                select(BoardEvent)
                .where(BoardEvent.audience_department_id.in_(department_ids))
                .order_by(BoardEvent.id)
            )
        )
        if department_ids
        else []
    )
    rows: list[LifecycleRowState] = []
    blockers: list[LifecycleBlocker] = []
    for board_event in events:
        department_id = board_event.audience_department_id
        assert department_id is not None  # The query above excludes NULL audiences.
        state = row_state("board_events", board_event)
        state.state_fingerprint = fingerprint(
            {
                key: getattr(board_event, key)
                for key in (
                    "board_id",
                    "author_id",
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
                    "audience_kind",
                    "audience_user_id",
                    "audience_department_id",
                    "archived",
                    "revision",
                )
            }
        )
        rows.append(state)
        department = departments_by_id.get(department_id)
        blockers.append(
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY,
                entity_type="board_events",
                entity_id=board_event.id,
                detail=(
                    "Permanently delete this Board event or change its audience before "
                    "purging the Department; this operation will not delete the event"
                ),
                conflicting_entity_type="departments",
                conflicting_entity_id=department_id,
                department_id=department_id,
                department_name=(department.department_name if department is not None else None),
            )
        )
    return (
        rows,
        blockers,
        {
            "board_events": tuple(event.id for event in events),
            "boards": tuple(sorted({event.board_id for event in events})),
        },
    )
