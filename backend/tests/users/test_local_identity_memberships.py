"""Behavior coverage for user administration after local Identity cutover."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock
from uuid import UUID

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.coordination as user_coordination
import app.systems.access.users.service as user_service
from app.systems.access.policy.service import CreationDefaults
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.models import (
    IdentityKind,
    Role,
    User,
    UserDepartment,
    UserRole,
    UserStatus,
)
from app.systems.access.users.schemas import InvitationCreate


def _role(name: UserRole = UserRole.MEMBER) -> Role:
    return Role(id=uuid7(), role=name, permissions={}, is_deleted=False)


def _user(role: Role, *, status: UserStatus = UserStatus.ACTIVE, deleted: bool = False) -> User:
    now = datetime.now(UTC)
    return User(
        id=uuid7(),
        email=f"{uuid7().hex}@example.com",
        username=f"user_{uuid7().hex[:12]}",
        identity_kind=IdentityKind.INTERNAL.value,
        status=status.value,
        role_id=role.id,
        role=role,
        created_at=now,
        updated_at=now,
        is_deleted=deleted,
        deleted_at=now if deleted else None,
    )


def _invitation(role_id=None) -> InvitationCreate:
    return InvitationCreate(email="person@example.com", username="person", role_id=role_id)


pytestmark = pytest.mark.usefixtures("local_identity_security_events")


@pytest.fixture(autouse=True)
def _creation_defaults_for_invitation_mocks(monkeypatch: pytest.MonkeyPatch) -> None:
    """Preserve each invitation test's pre-existing role-query setup."""

    def defaults(db: Session) -> CreationDefaults:
        role = db.scalar(Mock())
        return CreationDefaults(
            role=role if isinstance(role, Role) else _role(),
            group_ids=(),
            department_ids=(),
            invitation_expiry_days=7,
            guest_duration_days=30,
        )

    monkeypatch.setattr(user_service, "load_creation_defaults", defaults)


def test_department_membership_rejects_inactive_or_missing_department() -> None:
    department_id = uuid7()
    db = Mock(spec=Session)
    db.scalars.return_value.all.return_value = []

    with pytest.raises(user_coordination.ProfileValidationError, match="not active"):
        user_coordination.resolve_department_memberships(db, [department_id], None)


def test_department_membership_rejects_primary_outside_the_selected_departments() -> None:
    db = Mock(spec=Session)

    with pytest.raises(user_coordination.ProfileValidationError, match="Primary department"):
        user_coordination.resolve_department_memberships(db, [uuid7()], uuid7())

    db.scalars.assert_not_called()


def test_department_membership_replacement_and_clearing_are_atomic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = _user(_role())
    retained = UserDepartment(user_id=user.id, department_id=uuid7(), is_primary=False)
    removed = UserDepartment(user_id=user.id, department_id=uuid7(), is_primary=True)
    replacement = uuid7()
    db = Mock(spec=Session)
    db.scalars.return_value.all.side_effect = [[retained, removed], [retained]]
    monkeypatch.setattr(
        user_coordination,
        "resolve_department_memberships",
        lambda _db, department_ids, _primary_department_id: tuple(dict.fromkeys(department_ids)),
    )

    user_coordination.replace_department_memberships(
        db,
        user,
        department_ids=[retained.department_id, replacement],
        primary_department_id=replacement,
        primary_requested=True,
    )
    user_coordination.replace_department_memberships(
        db,
        user,
        department_ids=[],
        primary_department_id=None,
        primary_requested=False,
    )

    assert retained.is_primary is False
    assert [call.args[0] for call in db.delete.call_args_list] == [removed, retained]
    additions = [
        call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], UserDepartment)
    ]
    assert [(item.department_id, item.is_primary) for item in additions] == [(replacement, True)]


def test_membership_primary_swap_flushes_the_demotion_before_promoting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = _user(_role())
    current_primary = UserDepartment(user_id=user.id, department_id=uuid7(), is_primary=True)
    replacement = uuid7()
    db = Mock(spec=Session)
    db.scalars.return_value.all.return_value = [current_primary]
    monkeypatch.setattr(
        user_coordination,
        "resolve_department_memberships",
        lambda _db, department_ids, _primary_department_id: tuple(department_ids),
    )
    flushed_primary_states: list[bool] = []
    db.flush.side_effect = lambda: flushed_primary_states.append(current_primary.is_primary)

    user_coordination.replace_department_memberships(
        db,
        user,
        department_ids=[current_primary.department_id, replacement],
        primary_department_id=replacement,
        primary_requested=True,
    )

    assert flushed_primary_states == [False]
    additions = [
        call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], UserDepartment)
    ]
    assert [(item.department_id, item.is_primary) for item in additions] == [(replacement, True)]


def test_membership_replacement_preserves_remaining_primary_when_omitted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = _user(_role())
    current_primary = UserDepartment(user_id=user.id, department_id=uuid7(), is_primary=True)
    retained = UserDepartment(user_id=user.id, department_id=uuid7(), is_primary=False)
    db = Mock(spec=Session)
    db.scalars.return_value.all.return_value = [current_primary, retained]
    resolved_primary: list[UUID | None] = []
    monkeypatch.setattr(
        user_coordination,
        "resolve_department_memberships",
        lambda _db, department_ids, primary_department_id: (
            resolved_primary.append(primary_department_id) or tuple(department_ids)
        ),
    )

    user_coordination.replace_department_memberships(
        db,
        user,
        department_ids=[retained.department_id, current_primary.department_id],
        primary_department_id=None,
        primary_requested=False,
    )

    assert resolved_primary == [current_primary.department_id]
    assert current_primary.is_primary is True
    assert retained.is_primary is False
    db.flush.assert_not_called()


def test_membership_replacement_clears_primary_only_when_explicitly_null(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = _user(_role())
    current_primary = UserDepartment(user_id=user.id, department_id=uuid7(), is_primary=True)
    retained = UserDepartment(user_id=user.id, department_id=uuid7(), is_primary=False)
    db = Mock(spec=Session)
    db.scalars.return_value.all.return_value = [current_primary, retained]
    resolved_primary: list[UUID | None] = []
    monkeypatch.setattr(
        user_coordination,
        "resolve_department_memberships",
        lambda _db, department_ids, primary_department_id: (
            resolved_primary.append(primary_department_id) or tuple(department_ids)
        ),
    )

    user_coordination.replace_department_memberships(
        db,
        user,
        department_ids=[current_primary.department_id, retained.department_id],
        primary_department_id=None,
        primary_requested=True,
    )

    assert resolved_primary == [None]
    assert current_primary.is_primary is False
    db.flush.assert_called_once()


def test_expired_internal_identity_cannot_sponsor_a_guest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime(2026, 9, 22, tzinfo=UTC)
    sponsor = _user(_role())
    sponsor.expires_at = now
    role = _role()
    db = Mock(spec=Session)
    db.scalar.side_effect = [role, sponsor]
    monkeypatch.setattr(user_service, "utc_now", lambda: now)
    monkeypatch.setattr(user_coordination, "utc_now", lambda: now)
    payload = InvitationCreate(
        email="guest@example.com",
        username="guest",
        identity_kind=IdentityKind.GUEST,
        sponsor_user_id=sponsor.id,
        expires_at=now + timedelta(days=1),
    )

    with pytest.raises(InvitationError, match="sponsor"):
        user_service.invite_user(db, payload, bootstrap=True)


def test_department_memberships_disallow_implicit_lazy_loading() -> None:
    assert User.department_memberships.property.lazy == "raise"
