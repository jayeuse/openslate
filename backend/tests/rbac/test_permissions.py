"""Role gates and the account contracts that replace the flat capabilities."""

from __future__ import annotations

from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.common.dependencies.auth import require_admin, require_non_guest
from app.systems.access.policy.schemas import GroupAccessEntry, GroupAccessReplace
from app.systems.access.users.models import UserRole
from app.systems.access.users.schemas import InvitationCreate, UserUpdate

from .support import make_user


@pytest.mark.parametrize("role", [UserRole.MEMBER, UserRole.GUEST])
def test_admin_gate_rejects_members_and_guests(role: UserRole) -> None:
    user, membership = make_user(f"not-admin-{role}", role=role)
    db = Mock(spec=Session)
    db.dirty = set()
    db.scalars.return_value.all.return_value = [membership]
    with pytest.raises(HTTPException) as raised:
        require_admin(user, db)

    assert raised.value.status_code == 403


def test_admin_gate_accepts_an_administrator() -> None:
    admin, membership = make_user("admin", role=UserRole.ADMIN)
    db = Mock(spec=Session)
    db.dirty = set()
    db.scalars.return_value.all.return_value = [membership]

    assert require_admin(admin, db) is admin


def test_non_guest_gate_rejects_a_guest_and_accepts_members() -> None:
    member, membership = make_user("member", role=UserRole.MEMBER)
    guest, guest_membership = make_user("guest", role=UserRole.GUEST)
    db = Mock(spec=Session)
    db.dirty = set()
    db.scalars.return_value.all.side_effect = [[guest_membership], [membership]]

    with pytest.raises(HTTPException) as raised:
        require_non_guest(guest, db)

    assert raised.value.status_code == 403
    assert require_non_guest(member, db) is member


def test_invitation_takes_a_role_and_groups_and_rejects_retired_fields() -> None:
    invitation = InvitationCreate(email="new@example.com", username="new-user")

    assert invitation.role is UserRole.MEMBER
    assert invitation.group_ids == []
    for retired in ("role_id", "identity_kind", "department_ids", "primary_department_id"):
        with pytest.raises(ValidationError):
            InvitationCreate.model_validate(
                {"email": "new@example.com", "username": "new-user", retired: None}
            )


def test_account_update_cannot_turn_someone_into_a_guest() -> None:
    assert UserUpdate(role=UserRole.ADMIN).role is UserRole.ADMIN
    with pytest.raises(ValidationError):
        UserUpdate.model_validate({"role": "guest"})


def test_group_access_entries_accept_only_the_three_levels() -> None:
    entry = GroupAccessEntry.model_validate(
        {"department_id": "0192e1f2-0000-7000-8000-000000000001", "level": "manage"}
    )

    assert entry.module_id is None
    with pytest.raises(ValidationError):
        GroupAccessReplace.model_validate(
            {"access": [{"department_id": str(entry.department_id), "level": "owner"}]}
        )
