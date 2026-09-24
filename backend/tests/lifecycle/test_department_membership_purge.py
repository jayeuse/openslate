"""Department purge must account for retained user memberships."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from uuid6 import uuid7

from app.systems.access.users.models import Role, User, UserDepartmentMembership
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.exceptions import LifecyclePreflightError
from app.systems.sandbox.lifecycle.execution import execute_lifecycle
from app.systems.sandbox.lifecycle.planning import plan_lifecycle

pytestmark = pytest.mark.integration


def test_department_purge_blocks_retained_membership_even_after_soft_delete(
    integration_owner_db,
) -> None:
    db = integration_owner_db
    role = db.scalar(select(Role).where(Role.role == "member"))
    assert role is not None
    user_id = uuid7()
    user = User(
        id=user_id,
        email=f"purge-member-{user_id}@example.test",
        username=f"purge_member_{user_id.hex[:12]}",
        status="active",
        role_id=role.id,
    )
    department = Department(
        department_name=f"Membership purge {uuid7()}",
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    db.add_all([user, department])
    db.flush()
    membership = UserDepartmentMembership(user_id=user.id, department_id=department.id)
    db.add(membership)
    db.commit()

    active_plan = plan_lifecycle(db, "department", department.id, "purge", None)
    assert active_plan.scope_ids["user_department_memberships"] == (membership.id,)
    assert [(item.code, item.entity_id) for item in active_plan.blockers] == [
        ("purge_department_membership_dependency", membership.id)
    ]

    membership.is_deleted = True
    membership.deleted_at = datetime.now(UTC)
    db.commit()
    deleted_plan = plan_lifecycle(db, "department", department.id, "purge", None)
    assert deleted_plan.impact_digest != active_plan.impact_digest
    assert deleted_plan.impact_digest == plan_lifecycle(
        db, "department", department.id, "purge", None
    ).impact_digest
    assert deleted_plan.scope_ids["user_department_memberships"] == (membership.id,)
    assert [(item.code, item.entity_id) for item in deleted_plan.blockers] == [
        ("purge_department_membership_dependency", membership.id)
    ]

    with pytest.raises(LifecyclePreflightError) as caught:
        execute_lifecycle(db, deleted_plan)
    assert caught.value.blockers == deleted_plan.blockers
    assert db.get(Department, department.id) is not None
    assert db.get(UserDepartmentMembership, membership.id) is not None
