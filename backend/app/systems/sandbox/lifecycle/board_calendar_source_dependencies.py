"""Calendar sources of a purged field or module: listed and removed, never a blocker.

A source only names a module and one of its date fields; a calendar keeps working
without it. A field, module or Department purge therefore lists each Board or
personal source on a purged field or module and removes it in the same transaction.
Sources of the purged Department's own Boards are inventoried with those Boards.
"""

from collections.abc import Callable
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.systems.boards.calendar_source_models import BoardCalendarSource
from app.systems.sandbox.lifecycle.planning_scope import row_state
from app.systems.sandbox.lifecycle.schemas import LifecycleRowState

ENTITY = "board_calendar_sources"
_IDENTITY = ("board_id", "user_id", "module_id", "date_field_id")


def load_calendar_source_purge_dependencies(
    db: Session,
    field_ids: list[UUID],
    module_ids: list[UUID],
    cascaded_board_ids: tuple[UUID, ...],
    fingerprint: Callable[[object], str],
) -> tuple[list[LifecycleRowState], tuple[UUID, ...], set[UUID]]:
    """Rows to list, IDs to lock and remove, and the Boards to lock first."""

    targets = []
    if field_ids:
        targets.append(BoardCalendarSource.date_field_id.in_(field_ids))
    if module_ids:
        targets.append(BoardCalendarSource.module_id.in_(module_ids))
    if not targets:
        return [], (), set()
    statement = select(BoardCalendarSource).where(or_(*targets)).order_by(BoardCalendarSource.id)
    if cascaded_board_ids:
        statement = statement.where(
            or_(
                BoardCalendarSource.board_id.is_(None),
                BoardCalendarSource.board_id.not_in(cascaded_board_ids),
            )
        )
    sources = list(db.scalars(statement))
    rows = []
    for source in sources:
        state = row_state(ENTITY, source)
        state.state_fingerprint = fingerprint({name: getattr(source, name) for name in _IDENTITY})
        rows.append(state)
    return (
        rows,
        tuple(source.id for source in sources),
        {source.board_id for source in sources if source.board_id is not None},
    )
