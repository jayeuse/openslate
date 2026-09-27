"""Behavior coverage for user administration after local Identity cutover."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.account_operations as account_operations
import app.systems.access.users.service as user_service
from app.core.integrations.supabase_auth import ProviderUser
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
from app.systems.access.users.schemas import InvitationCreate, UserCreate, UserResponse, UserUpdate


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


def test_profile_create_keeps_legacy_internal_defaults_and_exposes_new_fields() -> None:
    payload = UserCreate(email="member@example.com", username="member")

    assert payload.identity_kind is IdentityKind.INTERNAL
    assert payload.display_name is None
    assert payload.job_title is None
    assert payload.sponsor_user_id is None
    assert payload.expires_at is None
    assert payload.department_ids is None
    assert payload.primary_department_id is None


def test_user_response_exposes_stably_sorted_department_memberships() -> None:
    user = _user(_role())
    department_a = uuid7()
    department_b = uuid7()
    user.identity_kind = IdentityKind.INTERNAL.value
    user.display_name = "Member"
    user.job_title = "Coordinator"
    user.sponsor_user_id = None
    user.expires_at = None
    invitation_sent_at = datetime.now(UTC)
    user.invitation_sent_at = invitation_sent_at
    user.department_memberships = [
        UserDepartment(user_id=user.id, department_id=department_b, is_primary=True),
        UserDepartment(user_id=user.id, department_id=department_a, is_primary=False),
    ]

    response = UserResponse.model_validate(user)

    assert response.identity_kind is IdentityKind.INTERNAL
    assert response.display_name == "Member"
    assert response.job_title == "Coordinator"
    assert response.invitation_sent_at == invitation_sent_at
    assert response.department_ids == sorted([department_a, department_b], key=str)
    assert response.primary_department_id == department_b
    user.invitation_sent_at = None
    assert UserResponse.model_validate(user).invitation_sent_at is None


def test_guest_invitation_rejects_missing_sponsor_before_creating_credentials() -> None:
    payload = InvitationCreate(
        email="guest@example.com",
        username="guest",
        identity_kind=IdentityKind.GUEST,
        expires_at=datetime.now(UTC),
    )
    db = Mock(spec=Session)
    db.scalar.return_value = _role()

    with pytest.raises(InvitationError, match="sponsor"):
        user_service.invite_user(db, payload, bootstrap=True)

    db.add.assert_not_called()
    db.commit.assert_not_called()


def test_guest_cannot_receive_administrator_role_during_profile_update() -> None:
    admin_role = _role(UserRole.ADMIN)
    member_role = _role()
    actor = _user(admin_role)
    guest = _user(member_role)
    guest.identity_kind = IdentityKind.GUEST.value
    guest.sponsor_user_id = uuid7()
    guest.expires_at = datetime.now(UTC)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, actor, guest, admin_role]

    with pytest.raises(HTTPException) as error:
        account_operations.update_user(
            guest.id,
            UserUpdate(role_id=admin_role.id),
            actor,
            db,
        )

    assert error.value.status_code == 409
    assert guest.role_id == member_role.id
    db.commit.assert_not_called()
    db.rollback.assert_called_once()


@pytest.mark.parametrize(
    "sponsor",
    [
        lambda: _user(_role(), status=UserStatus.DISABLED),
        lambda: _guest_sponsor(),
    ],
    ids=["inactive", "guest"],
)
def test_guest_invitation_rejects_ineligible_sponsor(
    sponsor,  # type: ignore[no-untyped-def]
) -> None:
    role = _role()
    payload = InvitationCreate(
        email="guest@example.com",
        username="guest",
        identity_kind=IdentityKind.GUEST,
        sponsor_user_id=uuid7(),
        expires_at=datetime.now(UTC).replace(year=datetime.now(UTC).year + 1),
    )
    db = Mock(spec=Session)
    db.scalar.side_effect = [role, sponsor()]

    with pytest.raises(InvitationError, match="sponsor"):
        user_service.invite_user(db, payload, bootstrap=True)

    db.add.assert_not_called()
    db.commit.assert_not_called()


def _guest_sponsor() -> User:
    sponsor = _user(_role())
    sponsor.identity_kind = IdentityKind.GUEST.value
    sponsor.sponsor_user_id = uuid7()
    sponsor.expires_at = datetime.now(UTC).replace(year=datetime.now(UTC).year + 1)
    return sponsor


def test_guest_invitation_rejects_administrator_role_before_persisting() -> None:
    admin_role = _role(UserRole.ADMIN)
    payload = InvitationCreate(
        email="guest@example.com",
        username="guest",
        role_id=admin_role.id,
        identity_kind=IdentityKind.GUEST,
        sponsor_user_id=uuid7(),
        expires_at=datetime.now(UTC).replace(year=datetime.now(UTC).year + 1),
    )
    db = Mock(spec=Session)
    db.scalar.return_value = admin_role

    with pytest.raises(InvitationError, match="administrators"):
        user_service.invite_user(db, payload, bootstrap=True)

    db.add.assert_not_called()
    db.commit.assert_not_called()


def test_guest_invitation_persists_profile_and_deduplicated_department_memberships(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    role = _role()
    sponsor = _user(_role())
    sponsor.identity_kind = IdentityKind.INTERNAL.value
    department_a = uuid7()
    department_b = uuid7()
    payload = InvitationCreate(
        email="guest@example.com",
        username="guest",
        display_name="Guest person",
        identity_kind=IdentityKind.GUEST,
        job_title="Observer",
        sponsor_user_id=sponsor.id,
        expires_at=datetime.now(UTC).replace(year=datetime.now(UTC).year + 1),
        department_ids=[department_b, department_a, department_b],
        primary_department_id=department_b,
    )
    db = Mock(spec=Session)
    db.scalar.side_effect = [role, sponsor, None]
    db.scalars.return_value.all.return_value = [
        SimpleNamespace(id=department_a),
        SimpleNamespace(id=department_b),
    ]
    monkeypatch.setattr(user_service, "append_security_event", Mock())
    provider = Mock()
    provider_id = uuid7()

    def created_profile():
        return next(
            call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], User)
        )

    db.flush.side_effect = lambda: setattr(created_profile(), "id", uuid7())
    monkeypatch.setattr(user_service, "get_user", lambda *_args: created_profile())
    provider.admin_create_invitation_user.side_effect = lambda email, local_id, operation_id: (
        ProviderUser(
            provider_id,
            None,
            email,
            {
                "openslate_user_id": str(local_id),
                "openslate_invitation_operation_id": str(operation_id),
            },
        )
    )
    provider.admin_send_invitation.return_value = ProviderUser(provider_id, None, payload.email)

    user = user_service.invite_user(db, payload, bootstrap=True, client=provider)

    assert user.display_name == "Guest person"
    assert user.identity_kind == IdentityKind.GUEST.value
    assert user.job_title == "Observer"
    assert user.sponsor_user_id == sponsor.id
    memberships = [
        call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], UserDepartment)
    ]
    assert [(item.department_id, item.is_primary) for item in memberships] == [
        (department_b, True),
        (department_a, False),
    ]
    assert user.supabase_user_id == provider_id
    assert user.status == UserStatus.PENDING.value
