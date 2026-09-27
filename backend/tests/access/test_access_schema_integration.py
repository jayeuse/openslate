"""Database rules for account roles and group access rows."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import UserRole
from tests.rbac.support import add_department, add_module, add_user, make_group_access

pytestmark = pytest.mark.integration


def _insert_user(db: Session, *, role: str, sponsor: bool, expires: bool) -> None:
    sponsor_row = add_user(db, role=UserRole.MEMBER) if sponsor else None
    suffix = uuid7().hex[-12:]
    db.connection().execute(
        text(
            "INSERT INTO users (id, email, username, role, status, sponsor_user_id, expires_at) "
            "VALUES (:id, :email, :username, :role, 'active', :sponsor, :expires)"
        ),
        {
            "id": uuid7(),
            "email": f"check-{suffix}@example.com",
            "username": f"check-{suffix}",
            "role": role,
            "sponsor": sponsor_row.id if sponsor_row is not None else None,
            "expires": datetime.now(UTC) + timedelta(days=3) if expires else None,
        },
    )


@pytest.mark.parametrize(
    ("role", "sponsor", "expires"),
    [
        ("owner", False, False),
        ("guest", False, True),
        ("guest", True, False),
        ("member", True, True),
    ],
    ids=["unknown-role", "guest-without-sponsor", "guest-without-expiry", "member-as-guest"],
)
def test_user_role_and_guest_rules_reject_invalid_rows(
    integration_db: Session, role: str, sponsor: bool, expires: bool
) -> None:
    with pytest.raises(IntegrityError), integration_db.begin_nested():
        _insert_user(integration_db, role=role, sponsor=sponsor, expires=expires)


def test_user_role_accepts_a_sponsored_expiring_guest_and_an_expiring_member(
    integration_db: Session,
) -> None:
    _insert_user(integration_db, role="guest", sponsor=True, expires=True)
    _insert_user(integration_db, role="member", sponsor=False, expires=True)


def test_group_access_is_unique_per_active_target_and_rejects_unknown_levels(
    integration_db: Session,
) -> None:
    inventory = add_department(integration_db)
    products = add_module(integration_db, inventory)
    department_row = make_group_access(integration_db, [], inventory, level=AccessLevel.READ)
    group_id = department_row.group_id

    for module_id in (None, products.id):
        if module_id is not None:
            integration_db.connection().execute(
                text(
                    "INSERT INTO group_access (id, group_id, department_id, module_id, level) "
                    "VALUES (:id, :group, :department, :module, 'write')"
                ),
                {"id": uuid7(), "group": group_id, "department": inventory.id, "module": module_id},
            )
        with pytest.raises(IntegrityError), integration_db.begin_nested():
            integration_db.connection().execute(
                text(
                    "INSERT INTO group_access (id, group_id, department_id, module_id, level) "
                    "VALUES (:id, :group, :department, :module, 'manage')"
                ),
                {"id": uuid7(), "group": group_id, "department": inventory.id, "module": module_id},
            )

    department_row.is_deleted = True
    department_row.deleted_at = utc_now()
    integration_db.flush()
    # A retired row does not block a new active row for the same target.
    integration_db.connection().execute(
        text(
            "INSERT INTO group_access (id, group_id, department_id, level) "
            "VALUES (:id, :group, :department, 'manage')"
        ),
        {"id": uuid7(), "group": group_id, "department": inventory.id},
    )
    with pytest.raises(IntegrityError), integration_db.begin_nested():
        integration_db.connection().execute(
            text(
                "INSERT INTO group_access (id, group_id, department_id, level) "
                "VALUES (:id, :group, :department, 'owner')"
            ),
            {"id": uuid7(), "group": group_id, "department": inventory.id},
        )
