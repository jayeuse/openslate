"""Group access rows that a department or module purge removes with its target."""

from collections.abc import Callable
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.systems.access.policy.models import GroupAccess
from app.systems.sandbox.lifecycle.planning_scope import row_state
from app.systems.sandbox.lifecycle.schemas import LifecycleRowState


def load_group_access_purge_dependencies(
    db: Session,
    department_ids: list[UUID],
    module_ids: list[UUID],
    fingerprint: Callable[[object], str],
) -> tuple[list[LifecycleRowState], tuple[UUID, ...]]:
    """Include active and soft-deleted access rows in impact, lock and purge scope.

    A closed department or module keeps its access rows so that a reopen restores
    the same access. Only a purge removes them, because they reference the target.
    """

    filters = []
    if department_ids:
        filters.append(GroupAccess.department_id.in_(department_ids))
    if module_ids:
        filters.append(GroupAccess.module_id.in_(module_ids))
    grants = (
        list(db.scalars(select(GroupAccess).where(or_(*filters)).order_by(GroupAccess.id)))
        if filters
        else []
    )
    rows: list[LifecycleRowState] = []
    for grant in grants:
        state = row_state("group_access", grant)
        state.state_fingerprint = fingerprint(
            {
                "group_id": grant.group_id,
                "department_id": grant.department_id,
                "module_id": grant.module_id,
                "level": grant.level,
            }
        )
        rows.append(state)
    return rows, tuple(grant.id for grant in grants)
