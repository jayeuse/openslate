"""Role gates and the account contracts that replace the flat capabilities."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.common.dependencies.auth import require_admin, require_non_guest
from app.systems.access.policy.schemas import GroupAccessEntry, GroupAccessReplace
from app.systems.access.users.models import UserRole
from app.systems.access.users.schemas import InvitationCreate, UserUpdate

from .support import make_user


@pytest.mark.parametrize("role", [UserRole.MEMBER, UserRole.GUEST])
def test_admin_gate_rejects_members_and_guests(role: UserRole) -> None:
    with pytest.raises(HTTPException) as raised:
        require_admin(make_user(f"not-admin-{role}", role=role))

    assert raised.value.status_code == 403


def test_admin_gate_accepts_an_administrator() -> None:
    admin = make_user("admin", role=UserRole.ADMIN)

    assert require_admin(admin) is admin


def test_non_guest_gate_rejects_a_guest_and_accepts_members() -> None:
    member = make_user("member", role=UserRole.MEMBER)

    with pytest.raises(HTTPException) as raised:
        require_non_guest(make_user("guest", role=UserRole.GUEST))

    assert raised.value.status_code == 403
    assert require_non_guest(member) is member


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
