"""Application account security with Supabase-owned authentication."""

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.account_operations as account_operations
import app.systems.access.users.service as user_service
from app.core.integrations.supabase_auth import InvalidProviderCredentials
from app.systems.access.identity.provider_actions import complete_invitation
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.models import UserRole, UserStatus
from app.systems.access.users.schemas import UserUpdate
from app.systems.manage.workspace.models import PlatformSettings
from tests.users.user_support import local_user


@pytest.fixture(autouse=True)
def _single_organization_accounts(monkeypatch):
    """These mock-database cases cover one organization; shared accounts have their own tests."""
    monkeypatch.setattr(account_operations, "shares_another_organization", lambda db, user: False)
    # Owner protection (PR #52 review) is owned by test_user_admin_http_integration.py.
    monkeypatch.setattr(account_operations, "protect_owners", lambda db, user: None)
    # Comms grant revocation uses real PostgreSQL in test_realtime_grant_routes.py.
    # These finite mock result queues continue to own account/session outcomes only.
    monkeypatch.setattr(account_operations, "revoke_stale", lambda db: None)


pytestmark = pytest.mark.usefixtures("local_identity_security_events")


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_account_security_state_changes_revoke_provider_backed_sessions(
    monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    actor, actor_membership = local_user(UserRole.ADMIN)
    member, membership = local_user()
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, member]
    db.dirty = set()
    db.scalars.return_value = MagicMock()
    db.scalars.return_value.all.side_effect = [[actor_membership], [membership]]
    revoke = Mock()
    monkeypatch.setattr(account_operations, "revoke_user_sessions", revoke, raising=False)
    monkeypatch.setattr(account_operations, "_record_security_event", lambda **_kwargs: None)

    if operation == "disable":
        account_operations.update_user(member.id, UserUpdate(status=UserStatus.DISABLED), actor, db)
    else:
        account_operations.delete_user(member.id, actor, db)

    revoke.assert_called_once_with(db, member.id, except_session_id=None)


@pytest.mark.parametrize("deleted", [False, True])
def test_resend_rejects_non_pending_or_deleted_profiles(
    monkeypatch: pytest.MonkeyPatch, deleted: bool
) -> None:
    admin, admin_membership = local_user(UserRole.ADMIN)
    active, _membership = local_user(deleted=deleted)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin, active]
    db.dirty = set()
    db.scalars.return_value.all.return_value = [admin_membership]
    db.scalars.return_value.one_or_none.return_value = None
    provider = Mock()

    with pytest.raises(InvitationError, match="not pending"):
        user_service.resend_invitation(db, active.id, actor_id=admin.id, client=provider)

    provider.admin_send_invitation.assert_not_called()

    db.commit.assert_not_called()


def test_provider_rejected_invitation_cannot_change_account_or_password(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    provider = Mock()
    provider.verify_email_action.side_effect = InvalidProviderCredentials("expired or consumed")
    policy = PlatformSettings(
        password_min_length=12, password_require_mixed_case=True, password_require_number=False
    )
    monkeypatch.setattr(
        "app.systems.access.identity.provider_actions.load_platform_policy", lambda _db: policy
    )

    with pytest.raises(InvitationError, match="Invitation token is invalid"):
        complete_invitation(db, "a" * 56, "New password", provider)

    provider.update_password.assert_not_called()
    db.commit.assert_not_called()
    db.scalar.assert_not_called()


def test_pending_user_cannot_be_enabled_or_disabled_by_administrator() -> None:
    admin, admin_membership = local_user(UserRole.ADMIN)
    pending, membership = local_user(status=UserStatus.PENDING)
    for requested in (UserStatus.ACTIVE, UserStatus.DISABLED):
        db = Mock(spec=Session)
        db.scalar.side_effect = [admin, pending]
        db.dirty = set()
        # The administrator's membership, then the target's in the same organization.
        db.scalars.return_value.all.side_effect = [[admin_membership], [membership]]
        with pytest.raises(HTTPException) as error:
            account_operations.update_user(pending.id, UserUpdate(status=requested), admin, db)
        assert error.value.status_code == 409


def test_last_active_admin_cannot_be_deleted() -> None:
    actor, actor_membership = local_user(UserRole.ADMIN)
    target, membership = local_user(UserRole.ADMIN)
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, target, 1]
    db.dirty = set()
    db.scalars.return_value.all.side_effect = [[actor_membership], [membership]]

    with pytest.raises(HTTPException) as error:
        account_operations.delete_user(target.id, actor, db)

    assert error.value.status_code == 409
    assert target.is_deleted is False


@pytest.mark.parametrize("expiry_offset", [-timedelta(days=1), timedelta(days=1)])
def test_last_administrator_cannot_be_given_an_expiry(expiry_offset: timedelta) -> None:
    actor, actor_membership = local_user(UserRole.ADMIN)
    target, membership = local_user(UserRole.ADMIN)
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, target, 1, 1]
    db.dirty = set()
    db.scalars.return_value.all.side_effect = [[actor_membership], [membership]]

    with pytest.raises(HTTPException) as error:
        account_operations.update_user(
            target.id,
            UserUpdate(expires_at=datetime.now(UTC) + expiry_offset),
            actor,
            db,
        )

    assert error.value.status_code == 409
    assert membership.expires_at is None
    db.commit.assert_not_called()


def test_only_durable_administrator_cannot_be_disabled_when_another_will_expire(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actor, actor_membership = local_user(UserRole.ADMIN)
    target, membership = local_user(UserRole.ADMIN)
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, target, 2, 1]
    db.dirty = set()
    db.scalars.return_value.all.side_effect = [[actor_membership], [membership]]
    monkeypatch.setattr(account_operations, "_record_security_event", lambda **_kwargs: None)

    with pytest.raises(HTTPException) as error:
        account_operations.update_user(target.id, UserUpdate(status=UserStatus.DISABLED), actor, db)

    assert error.value.status_code == 409
    assert target.status == UserStatus.ACTIVE.value
    db.commit.assert_not_called()


def test_only_durable_administrator_cannot_be_deleted_when_another_will_expire(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actor, actor_membership = local_user(UserRole.ADMIN)
    target, membership = local_user(UserRole.ADMIN)
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, target, 2, 1]
    db.dirty = set()
    db.scalars.return_value.all.side_effect = [[actor_membership], [membership]]
    monkeypatch.setattr(account_operations, "_record_security_event", lambda **_kwargs: None)

    with pytest.raises(HTTPException) as error:
        account_operations.delete_user(target.id, actor, db)

    assert error.value.status_code == 409
    assert target.is_deleted is False
    db.commit.assert_not_called()


def test_disabled_user_is_locally_revoked_without_provider_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actor, actor_membership = local_user(UserRole.ADMIN)
    member, membership = local_user()
    events = Mock()
    monkeypatch.setattr(account_operations, "_record_security_event", events)
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, member, member.id]
    db.dirty = set()
    db.scalars.return_value = MagicMock()
    db.scalars.return_value.all.side_effect = [[actor_membership], [membership]]

    result = account_operations.update_user(
        member.id, UserUpdate(status=UserStatus.DISABLED), actor, db
    )

    assert result.status == UserStatus.DISABLED.value
    assert member.tokens_valid_after is not None
    db.commit.assert_called_once()
    assert [call.kwargs["outcome"].value for call in events.call_args_list] == [
        "attempt",
        "success",
    ]


def test_operator_can_restore_a_deleted_established_account(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actor, actor_membership = local_user(UserRole.ADMIN)
    target, membership = local_user(deleted=True)
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, target, membership, actor.id]
    db.dirty = set()
    db.scalars.return_value.all.side_effect = [[actor_membership], [membership]]
    monkeypatch.setattr(account_operations, "_record_security_event", lambda **_kwargs: None)

    result = account_operations.restore_user(target.id, actor, db)

    assert result.id == target.id
    assert target.is_deleted is False
    assert target.status == UserStatus.ACTIVE.value
    db.commit.assert_called_once()


def test_empty_user_patch_is_rejected_before_database_work() -> None:
    db = Mock(spec=Session)

    with pytest.raises(HTTPException) as user_error:
        account_operations.update_user(uuid7(), UserUpdate(), Mock(), db)

    assert user_error.value.status_code == 422
    db.scalar.assert_not_called()


def test_user_cannot_delete_their_own_account() -> None:
    admin, membership = local_user(UserRole.ADMIN)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin, admin]
    db.dirty = set()
    db.scalars.return_value.all.return_value = [membership]

    with pytest.raises(HTTPException) as error:
        account_operations.delete_user(admin.id, admin, db)

    assert error.value.status_code == 403
    db.commit.assert_not_called()


def test_removing_last_admin_role_assignment_is_rejected() -> None:
    actor, actor_membership = local_user(UserRole.ADMIN)
    target, membership = local_user(UserRole.ADMIN)
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, target, 1]
    db.dirty = set()
    db.scalars.return_value.all.side_effect = [[actor_membership], [membership]]

    with pytest.raises(HTTPException) as error:
        account_operations.update_user(
            target.id,
            UserUpdate(role=UserRole.MEMBER, status=UserStatus.DISABLED),
            actor,
            db,
        )

    assert error.value.status_code == 409
    assert membership.role == UserRole.ADMIN.value


def test_local_disable_commit_failure_records_attempt_and_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    actor, actor_membership = local_user(UserRole.ADMIN)
    target, membership = local_user()
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, target, target.id]
    db.dirty = set()
    db.scalars.return_value = MagicMock()
    db.scalars.return_value.all.side_effect = [[actor_membership], [membership]]
    db.commit.side_effect = SQLAlchemyError("database unavailable")
    events = Mock()
    monkeypatch.setattr(account_operations, "_record_security_event", events)

    with pytest.raises(HTTPException) as error:
        account_operations.update_user(target.id, UserUpdate(status=UserStatus.DISABLED), actor, db)

    assert error.value.status_code == 503
    assert [call.kwargs["outcome"].value for call in events.call_args_list] == [
        "attempt",
        "failure",
    ]
