from datetime import UTC, datetime
from unittest.mock import MagicMock, Mock

import pytest
from uuid6 import uuid7

import scripts.bootstrap_admin as bootstrap_admin
from app.core.config import Settings
from app.core.integrations.supabase import SupabaseAdminClient
from app.systems.auth.schemas import InvitationCreate
from app.systems.users.models import Role, User, UserRole, UserStatus


def _role(name: str) -> Role:
    result = Role(role=name, permissions={})
    result.id = uuid7()
    return result


def _profile(
    user_id,
    assigned_role: Role,
    *,
    status: str,
    email: str = "admin@example.com",
    username: str = "bootstrap-admin",
    deleted: bool = False,
) -> User:
    return User(
        id=user_id,
        email=email,
        username=username,
        status=status,
        role_id=assigned_role.id,
        role=assigned_role,
        is_deleted=deleted,
    )


def _session_context(database: Mock) -> MagicMock:
    context = MagicMock()
    context.__enter__.return_value = database
    context.__exit__.return_value = None
    return context


def _patch_bootstrap(monkeypatch: pytest.MonkeyPatch, database: Mock) -> None:
    monkeypatch.setattr(bootstrap_admin, "AuditSession", lambda _engine: _session_context(database))
    monkeypatch.setattr(bootstrap_admin, "get_engine", lambda: object())


def test_bootstrap_invites_pending_admin_without_promoting_or_deleting_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    member_role = _role(UserRole.MEMBER)
    admin_role = _role(UserRole.ADMIN)
    invited = _profile(uuid7(), member_role, status=UserStatus.PENDING.value)
    database = Mock()
    database.info = {}
    database.scalar.side_effect = [None, member_role, admin_role, None, None, 0]
    auth_client = Mock(spec=SupabaseAdminClient)
    invited_call = Mock(return_value=invited)
    _patch_bootstrap(monkeypatch, database)
    monkeypatch.setattr(bootstrap_admin, "SupabaseAdminClient", lambda _settings: auth_client)
    monkeypatch.setattr(bootstrap_admin, "invite_user", invited_call)

    result = bootstrap_admin._provision(
        Mock(spec=Settings),
        InvitationCreate(email=invited.email, username=invited.username),
    )

    assert result is invited
    invited_call.assert_called_once()
    call = invited_call.call_args
    assert call.kwargs["actor_id"] is None
    assert call.kwargs["bootstrap"] is True
    assert call.args[1].role_id == admin_role.id
    assert invited.status == UserStatus.PENDING.value
    database.commit.assert_not_called()
    auth_client.delete_user.assert_not_called()


def test_bootstrap_retries_the_exact_pending_admin_reservation_idempotently(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    member_role = _role(UserRole.MEMBER)
    admin_role = _role(UserRole.ADMIN)
    reservation = _profile(
        uuid7(),
        admin_role,
        status=UserStatus.PENDING.value,
    )
    reservation.invitation_sent_at = datetime.now(UTC)
    database = Mock()
    database.info = {}
    database.scalar.side_effect = [None, member_role, admin_role, reservation, reservation, 0]
    auth_client = Mock(spec=SupabaseAdminClient)
    _patch_bootstrap(monkeypatch, database)
    monkeypatch.setattr(bootstrap_admin, "SupabaseAdminClient", lambda _settings: auth_client)

    result = bootstrap_admin._provision(
        Mock(spec=Settings),
        InvitationCreate(email=" ADMIN@example.com ", username=" Bootstrap-Admin "),
    )

    assert result is reservation
    database.commit.assert_not_called()
    auth_client.invite_user.assert_not_called()


def test_bootstrap_exact_reservation_does_not_bypass_another_admin_assignment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    member_role = _role(UserRole.MEMBER)
    admin_role = _role(UserRole.ADMIN)
    reservation = _profile(
        uuid7(),
        admin_role,
        status=UserStatus.PENDING.value,
    )
    reservation.invitation_sent_at = datetime.now(UTC)
    database = Mock()
    database.info = {}
    database.scalar.side_effect = [None, member_role, admin_role, reservation, reservation, 1]
    _patch_bootstrap(monkeypatch, database)

    with pytest.raises(bootstrap_admin.BootstrapError, match="administrator reservation"):
        bootstrap_admin._provision(
            Mock(spec=Settings),
            InvitationCreate(email=reservation.email, username=reservation.username),
        )

    database.commit.assert_not_called()


@pytest.mark.parametrize(
    ("status", "deleted", "username"),
    [
        (UserStatus.PENDING.value, False, "bootstrap-admin"),
        (UserStatus.DISABLED.value, False, "bootstrap-admin"),
        (UserStatus.PENDING.value, True, "bootstrap-admin"),
        (UserStatus.PENDING.value, False, "auth_placeholder"),
    ],
)
def test_bootstrap_does_not_promote_existing_member_disabled_deleted_or_placeholder_profiles(
    monkeypatch: pytest.MonkeyPatch,
    status: str,
    deleted: bool,
    username: str,
) -> None:
    member_role = _role(UserRole.MEMBER)
    admin_role = _role(UserRole.ADMIN)
    existing = _profile(
        uuid7(),
        member_role,
        status=status,
        deleted=deleted,
        username=username,
    )
    database = Mock()
    database.info = {}
    database.scalar.side_effect = [None, member_role, admin_role, existing, existing]
    auth_client = Mock(spec=SupabaseAdminClient)
    _patch_bootstrap(monkeypatch, database)
    monkeypatch.setattr(bootstrap_admin, "SupabaseAdminClient", lambda _settings: auth_client)

    with pytest.raises(bootstrap_admin.BootstrapError, match="already associated"):
        bootstrap_admin._provision(
            Mock(spec=Settings),
            InvitationCreate(email=existing.email, username="bootstrap-admin"),
        )

    assert existing.role_id == member_role.id
    assert existing.status == status
    database.commit.assert_not_called()
    auth_client.invite_user.assert_not_called()


def test_bootstrap_preflight_blocks_a_different_existing_admin_reservation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    member_role = _role(UserRole.MEMBER)
    admin_role = _role(UserRole.ADMIN)
    database = Mock()
    database.info = {}
    database.scalar.side_effect = [None, member_role, admin_role, None, None, 1]
    auth_client = Mock(spec=SupabaseAdminClient)
    _patch_bootstrap(monkeypatch, database)
    monkeypatch.setattr(bootstrap_admin, "SupabaseAdminClient", lambda _settings: auth_client)

    with pytest.raises(bootstrap_admin.BootstrapError, match="administrator reservation"):
        bootstrap_admin._provision(
            Mock(spec=Settings),
            InvitationCreate(email="second@example.com", username="second-admin"),
        )

    database.commit.assert_not_called()
    auth_client.invite_user.assert_not_called()


def test_bootstrap_blocks_a_non_pending_admin_assignment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    member_role = _role(UserRole.MEMBER)
    admin_role = _role(UserRole.ADMIN)
    database = Mock()
    database.info = {}
    database.scalar.side_effect = [None, member_role, admin_role, None, None, 1]
    _patch_bootstrap(monkeypatch, database)

    with pytest.raises(bootstrap_admin.BootstrapError, match="administrator reservation"):
        bootstrap_admin._provision(
            Mock(spec=Settings),
            InvitationCreate(email="second@example.com", username="second-admin"),
        )

    database.commit.assert_not_called()
