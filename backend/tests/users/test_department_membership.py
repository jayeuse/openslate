"""Department membership persistence and fail-closed eligibility."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import inspect, select
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.systems.access.users import eligibility, models
from app.systems.sandbox.departments.models import Department

pytestmark = pytest.mark.integration


def _membership_graph(db):
    role = db.scalar(select(models.Role).where(models.Role.role == "member"))
    assert role is not None
    user_id = uuid7()
    user = models.User(
        id=user_id,
        email=f"department-{user_id}@example.test",
        username=f"dept_{user_id.hex[:12]}",
        status="active",
        role_id=role.id,
    )
    department = Department(department_name=f"Membership {uuid7()}")
    db.add_all([user, department])
    db.flush()
    membership = models.UserDepartmentMembership(user_id=user.id, department_id=department.id)
    db.add(membership)
    db.flush()
    return user, department, membership


def test_membership_requires_active_established_user_department_and_link(
    integration_owner_db,
) -> None:
    db = integration_owner_db
    user, department, membership = _membership_graph(db)

    def eligible() -> bool:
        return eligibility.has_active_department_membership(db, user.id, department.id)

    assert eligible()

    membership.is_deleted = True
    db.flush()
    assert not eligible()
    membership.is_deleted = False
    membership.deleted_at = datetime.now(UTC)
    db.flush()
    assert not eligible()
    membership.deleted_at = None

    user.status = "disabled"
    db.flush()
    assert not eligible()
    user.status = "pending"
    db.flush()
    assert not eligible()
    user.status = "active"
    user.invitation_sent_at = datetime.now(UTC)
    db.flush()
    assert not eligible()
    user.invitation_accepted_at = datetime.now(UTC)
    db.flush()
    assert eligible()
    user.is_deleted = True
    db.flush()
    assert not eligible()
    user.is_deleted = False
    user.deleted_at = datetime.now(UTC)
    db.flush()
    assert not eligible()
    user.deleted_at = None

    department.is_deleted = True
    db.flush()
    assert not eligible()
    department.is_deleted = False
    department.deleted_at = datetime.now(UTC)
    db.flush()
    assert not eligible()
    department.deleted_at = None
    db.flush()
    assert eligible()
    assert not eligibility.has_active_department_membership(db, user.id, uuid7())


def test_membership_pair_is_unique_and_both_parent_links_restrict_delete(
    integration_owner_db,
) -> None:
    db = integration_owner_db
    user, department, _membership = _membership_graph(db)

    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(models.UserDepartmentMembership(user_id=user.id, department_id=department.id))
            db.flush()

    for missing_user_id, missing_department_id in (
        (uuid7(), department.id),
        (user.id, uuid7()),
    ):
        with pytest.raises(IntegrityError):
            with db.begin_nested():
                db.add(
                    models.UserDepartmentMembership(
                        user_id=missing_user_id,
                        department_id=missing_department_id,
                    )
                )
                db.flush()

    delete_actions = {
        tuple(foreign_key["constrained_columns"]): foreign_key["options"].get("ondelete")
        for foreign_key in inspect(db.get_bind()).get_foreign_keys("user_department_memberships")
    }
    assert delete_actions[("user_id",)] == "RESTRICT"
    assert delete_actions[("department_id",)] == "RESTRICT"
