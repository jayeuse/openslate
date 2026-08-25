from unittest.mock import Mock
from uuid import uuid7

import pytest
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

import app.systems.users.router as users_router
from app.core.integrations.supabase import (
    SupabaseAdminClient,
    SupabaseAdminError,
    SupabaseAuthUser,
)
from app.systems.auth.schemas import InvitationCreate
from app.systems.users.models import Role, User, UserRole, UserStatus
from app.systems.users.schemas import UserCreate, UserUpdate
from app.systems.users.service import InvitationConflict, InvitationError, invite_user


def role(name: str = UserRole.MEMBER, *, deleted: bool = False) -> Role:
    result = Role(role=name, permissions={}, is_deleted=deleted)
    result.id = uuid7()
    return result


def profile(user_id, assigned_role: Role, *, status: str = UserStatus.PENDING.value) -> User:
    return User(
        id=user_id,
        email="trigger@example.com",
        username="auth_profile",
        status=status,
        role_id=assigned_role.id,
        role=assigned_role,
        is_deleted=False,
    )


def invitation(role_id=None) -> InvitationCreate:
    return InvitationCreate(
        email=" Invited@Example.com ",
        username=" New_User ",
        role_id=role_id,
    )


def auth_client(auth_id=None) -> Mock:
    client = Mock(spec=SupabaseAdminClient)
    client.invite_user.return_value = SupabaseAuthUser(
        auth_id or uuid7(), "invited@example.com"
    )
    return client


def test_invitation_finalizes_trigger_created_pending_profile_and_commits() -> None:
    assigned_role = role()
    auth_id = uuid7()
    pending_profile = profile(auth_id, assigned_role)
    client = auth_client(auth_id)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None, pending_profile]

    result = invite_user(db, invitation(assigned_role.id), client=client)

    assert result is pending_profile
    assert pending_profile.email == "invited@example.com"
    assert pending_profile.username == "new_user"
    assert pending_profile.status == UserStatus.ACTIVE.value
    assert pending_profile.is_deleted is False
    assert pending_profile.deleted_at is None
    assert pending_profile.role is assigned_role
    client.invite_user.assert_called_once_with("invited@example.com", "new_user")
    client.delete_user.assert_not_called()
    db.commit.assert_called_once()
    db.refresh.assert_called_once_with(pending_profile)


def test_invitation_compensates_when_auth_trigger_profile_is_missing() -> None:
    assigned_role = role()
    auth_id = uuid7()
    client = auth_client(auth_id)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None, None]

    with pytest.raises(InvitationError, match="finalize"):
        invite_user(db, invitation(assigned_role.id), client=client)

    db.rollback.assert_called_once()
    client.delete_user.assert_called_once_with(auth_id)
    db.commit.assert_not_called()


def test_invitation_rejects_local_duplicate_before_calling_supabase() -> None:
    assigned_role = role()
    duplicate = profile(uuid7(), assigned_role)
    client = auth_client()
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, duplicate]

    with pytest.raises(InvitationConflict, match="already in use"):
        invite_user(db, invitation(assigned_role.id), client=client)

    client.invite_user.assert_not_called()
    db.commit.assert_not_called()


def test_invitation_replaces_a_stranded_pending_auth_profile() -> None:
    assigned_role = role()
    stale_profile = profile(uuid7(), assigned_role)
    stale_profile.email = "invited@example.com"
    stale_profile.username = f"auth_{stale_profile.id.hex}"
    replacement_id = uuid7()
    replacement_profile = profile(replacement_id, assigned_role)
    client = auth_client(replacement_id)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, stale_profile, replacement_profile]

    result = invite_user(db, invitation(assigned_role.id), client=client)

    assert result is replacement_profile
    client.delete_user.assert_called_once_with(stale_profile.id)
    client.invite_user.assert_called_once_with("invited@example.com", "new_user")
    db.expire_all.assert_called_once()
    assert replacement_profile.status == UserStatus.ACTIVE.value


def test_invitation_fails_safely_when_pending_profile_reconciliation_fails() -> None:
    assigned_role = role()
    stale_profile = profile(uuid7(), assigned_role)
    stale_profile.email = "invited@example.com"
    stale_profile.username = f"auth_{stale_profile.id.hex}"
    client = auth_client()
    client.delete_user.side_effect = SupabaseAdminError("upstream")
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, stale_profile]

    with pytest.raises(InvitationError, match="reconcile"):
        invite_user(db, invitation(assigned_role.id), client=client)

    client.invite_user.assert_not_called()


@pytest.mark.parametrize("status_code", [409, 422])
def test_invitation_maps_supabase_duplicate_to_conflict(status_code: int) -> None:
    assigned_role = role()
    client = auth_client()
    client.invite_user.side_effect = SupabaseAdminError("upstream", status_code=status_code)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None]

    with pytest.raises(InvitationConflict, match="already in use"):
        invite_user(db, invitation(assigned_role.id), client=client)


def test_invitation_maps_other_supabase_error_to_safe_error() -> None:
    assigned_role = role()
    client = auth_client()
    client.invite_user.side_effect = SupabaseAdminError("upstream", status_code=503)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None]

    with pytest.raises(InvitationError, match="send invitation"):
        invite_user(db, invitation(assigned_role.id), client=client)


def test_invitation_rejects_inactive_or_missing_role_without_external_call() -> None:
    client = auth_client()
    db = Mock(spec=Session)
    db.scalar.return_value = None

    with pytest.raises(InvitationError, match="Role is not active"):
        invite_user(db, invitation(uuid7()), client=client)

    client.invite_user.assert_not_called()


def test_invitation_requires_an_active_default_member_role() -> None:
    client = auth_client()
    db = Mock(spec=Session)
    db.scalar.return_value = None

    with pytest.raises(InvitationError, match="Default member role"):
        invite_user(db, invitation(), client=client)

    client.invite_user.assert_not_called()


@pytest.mark.parametrize(
    "commit_error",
    [IntegrityError("stmt", {}, Exception()), SQLAlchemyError()],
)
def test_invitation_rolls_back_and_compensates_finalize_failures(commit_error: Exception) -> None:
    assigned_role = role()
    auth_id = uuid7()
    pending_profile = profile(auth_id, assigned_role)
    client = auth_client(auth_id)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None, pending_profile]
    db.commit.side_effect = commit_error

    expected = InvitationConflict if isinstance(commit_error, IntegrityError) else InvitationError
    with pytest.raises(expected):
        invite_user(db, invitation(assigned_role.id), client=client)

    db.rollback.assert_called_once()
    client.delete_user.assert_called_once_with(auth_id)


def test_router_create_user_returns_invited_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    assigned_role = role()
    invited = profile(uuid7(), assigned_role, status=UserStatus.ACTIVE.value)
    monkeypatch.setattr(users_router, "invite_user", lambda *_args, **_kwargs: invited)

    result = users_router.create_user(
        UserCreate(email="person@example.com", username="person", role_id=assigned_role.id),
        invited,
        Mock(spec=Session),
    )

    assert result is invited


@pytest.mark.parametrize(
    ("error", "status_code"),
    [
        (InvitationConflict("duplicate"), 409),
        (InvitationError("upstream"), 502),
    ],
)
def test_router_maps_invitation_errors_to_api_responses(
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    status_code: int,
) -> None:
    monkeypatch.setattr(users_router, "invite_user", Mock(side_effect=error))

    with pytest.raises(users_router.HTTPException) as raised:
        users_router.create_user(
            UserCreate(email="person@example.com", username="person"),
            Mock(),
            Mock(spec=Session),
        )

    assert raised.value.status_code == status_code


def test_activation_commits_local_status_only_after_auth_enable_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.DISABLED.value)
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    db = Mock(spec=Session)
    db.scalar.return_value = user

    result = users_router.update_user(user.id, UserUpdate(status=UserStatus.ACTIVE), user, db)

    assert result is user
    assert user.status == UserStatus.ACTIVE.value
    client.enable_user.assert_called_once_with(user.id)
    db.commit.assert_called_once()


def test_activation_fails_closed_when_auth_enable_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.DISABLED.value)
    client = Mock(spec=SupabaseAdminClient)
    client.enable_user.side_effect = SupabaseAdminError("upstream")
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    db = Mock(spec=Session)
    db.scalar.return_value = user

    with pytest.raises(users_router.HTTPException) as error:
        users_router.update_user(user.id, UserUpdate(status=UserStatus.ACTIVE), user, db)

    assert error.value.status_code == 503
    assert user.status == UserStatus.DISABLED.value
    db.commit.assert_not_called()


def test_disable_commits_local_lock_before_remote_disable_and_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role)
    client = Mock(spec=SupabaseAdminClient)
    client.disable_user.side_effect = SupabaseAdminError("upstream")
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    db = Mock(spec=Session)
    db.scalar.return_value = user

    with pytest.raises(users_router.HTTPException) as error:
        users_router.update_user(user.id, UserUpdate(status=UserStatus.DISABLED), user, db)

    assert error.value.status_code == 503
    assert user.status == UserStatus.DISABLED.value
    db.commit.assert_called_once()
    client.disable_user.assert_called_once_with(user.id)
