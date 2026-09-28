"""The Board of a purged Department: an empty Board goes with it, content blocks."""

from collections.abc import Callable
from typing import Any
from uuid import UUID

from sqlalchemy import exists, or_, select
from sqlalchemy.orm import Session

from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardGroup, BoardWidget
from app.systems.boards.post_models import BoardPost
from app.systems.platform.files.models import File
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.planning_scope import row_state
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleRowState,
)

_CONTENT: tuple[Any, ...] = (BoardPost, BoardEvent, BoardWidget, BoardGroup, File)


def _has_content(board_id: UUID) -> Any:
    return or_(
        *(exists(select(model.id).where(model.board_id == board_id)) for model in _CONTENT)
    )


def load_department_board_purge_dependencies(
    db: Session,
    department_ids: list[UUID],
    departments_by_id: dict[UUID, Department],
    fingerprint: Callable[[object], str],
) -> tuple[list[LifecycleRowState], list[LifecycleBlocker], tuple[UUID, ...]]:
    """Return the Boards of the Departments; a Board with content blocks the purge.

    Posts, events, tiles and files of a Board are removed only by the Board purge,
    which keeps its own confirmation. An empty Board is removed with its Department.
    """

    boards = (
        list(
            db.scalars(
                select(Board).where(Board.department_id.in_(department_ids)).order_by(Board.id)
            )
        )
        if department_ids
        else []
    )
    rows: list[LifecycleRowState] = []
    blockers: list[LifecycleBlocker] = []
    for board in boards:
        state = row_state("boards", board)
        state.state_fingerprint = fingerprint(
            {
                key: getattr(board, key)
                for key in ("scope", "department_id", "name", "description", "status", "revision")
            }
        )
        rows.append(state)
        if not db.scalar(select(_has_content(board.id))):
            continue
        department = (
            departments_by_id.get(board.department_id) if board.department_id is not None else None
        )
        blockers.append(
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY,
                entity_type="boards",
                entity_id=board.id,
                detail=(
                    "Permanently delete this Department's Board before purging the Department; "
                    "the Board still has posts, events, tiles or files"
                ),
                conflicting_entity_type="departments",
                conflicting_entity_id=board.department_id,
                department_id=board.department_id,
                department_name=(department.department_name if department is not None else None),
            )
        )
    return rows, blockers, tuple(board.id for board in boards)
