"""Retained Department memberships that block physical Department purge."""

from collections.abc import Callable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.users.models import UserDepartmentMembership
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.planning_scope import row_state
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleRowState,
)


def load_membership_purge_dependencies(
    db: Session,
    department_ids: list[UUID],
    departments_by_id: dict[UUID, Department],
    fingerprint: Callable[[object], str],
) -> tuple[list[LifecycleRowState], list[LifecycleBlocker], tuple[UUID, ...]]:
    """Include active and soft-deleted membership rows in impact and lock scope."""

    memberships = (
        list(
            db.scalars(
                select(UserDepartmentMembership)
                .where(UserDepartmentMembership.department_id.in_(department_ids))
                .order_by(UserDepartmentMembership.id)
            )
        )
        if department_ids
        else []
    )
    rows: list[LifecycleRowState] = []
    blockers: list[LifecycleBlocker] = []
    for membership in memberships:
        state = row_state("user_department_memberships", membership)
        state.state_fingerprint = fingerprint(
            {"user_id": membership.user_id, "department_id": membership.department_id}
        )
        rows.append(state)
        department = departments_by_id.get(membership.department_id)
        blockers.append(
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_DEPARTMENT_MEMBERSHIP_DEPENDENCY,
                entity_type="user_department_memberships",
                entity_id=membership.id,
                detail=(
                    "A retained user membership references this Department; resolve the "
                    "membership before purging. This purge will not delete it automatically"
                ),
                conflicting_entity_type="departments",
                conflicting_entity_id=membership.department_id,
                department_id=membership.department_id,
                department_name=(department.department_name if department is not None else None),
            )
        )
    return rows, blockers, tuple(membership.id for membership in memberships)
