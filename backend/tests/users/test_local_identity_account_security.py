"""Application account security with Supabase-owned authentication."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

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
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.users.test_local_identity_users import _user

pytestmark = pytest.mark.usefixtures("local_identity_security_events")


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_account_security_state_changes_revoke_provider_backed_sessions(
    monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    actor = _user(UserRole.ADMIN)
    member = _user()
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, member]
    db.scalars.return_value = []
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
    admin = _user(UserRole.ADMIN)
    active = _user(deleted=deleted)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin, active]
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
    policy = WorkspaceProfile(
        password_min_length=12, password_require_mixed_case=True, password_require_number=False
    )
    monkeypatch.setattr(
        "app.systems.access.identity.provider_actions.load_workspace_policy", lambda _db: policy
    )

    with pytest.raises(InvitationError, match="Invitation token is invalid"):
        complete_invitation(db, "a" * 56, "New password", provider)

    provider.update_password.assert_not_called()
    db.commit.assert_not_called()
    db.scalar.assert_not_called()


def test_pending_user_cannot_be_enabled_or_disabled_by_administrator() -> None:
    admin = _user(UserRole.ADMIN)
    pending = _user(status=UserStatus.PENDING)
    for requested in (UserStatus.ACTIVE, UserStatus.DISABLED):
        db = Mock(spec=Session)
        db.scalar.side_effect = [admin, pending]
        with pytest.raises(HTTPException) as error:
            account_operations.update_user(pending.id, UserUpdate(status=requested), admin, db)
        assert error.value.status_code == 409


def test_last_active_admin_cannot_be_deleted() -> None:
    actor = _user(UserRole.ADMIN)
    target = _user(UserRole.ADMIN)
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, target, 1]

    with pytest.raises(HTTPException) as error:
        account_operations.delete_user(target.id, actor, db)

    assert error.value.status_code == 409
    assert target.is_deleted is False


@pytest.mark.parametrize("expiry_offset", [-timedelta(days=1), timedelta(days=1)])
def test_last_administrator_cannot_be_given_an_expiry(expiry_offset: timedelta) -> None:
    actor = _user(UserRole.ADMIN)
    target = _user(UserRole.ADMIN)
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, target, 1, 1]

    with pytest.raises(HTTPException) as error:
        account_operations.update_user(
            target.id,
            UserUpdate(expires_at=datetime.now(UTC) + expiry_offset),
            actor,
            db,
        )

    assert error.value.status_code == 409
    assert target.expires_at is None
    db.commit.assert_not_called()


def test_only_durable_administrator_cannot_be_disabled_when_another_will_expire(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actor = _user(UserRole.ADMIN)
    target = _user(UserRole.ADMIN)
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, target, 2, 1]
    db.scalars.return_value = []
    monkeypatch.setattr(account_operations, "_record_security_event", lambda **_kwargs: None)

    with pytest.raises(HTTPException) as error:
        account_operations.update_user(target.id, UserUpdate(status=UserStatus.DISABLED), actor, db)

    assert error.value.status_code == 409
    assert target.status == UserStatus.ACTIVE.value
    db.commit.assert_not_called()


def test_only_durable_administrator_cannot_be_deleted_when_another_will_expire(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actor = _user(UserRole.ADMIN)
    target = _user(UserRole.ADMIN)
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, target, 2, 1]
    db.scalars.return_value = []
    monkeypatch.setattr(account_operations, "_record_security_event", lambda **_kwargs: None)

    with pytest.raises(HTTPException) as error:
        account_operations.delete_user(target.id, actor, db)

    assert error.value.status_code == 409
    assert target.is_deleted is False
    db.commit.assert_not_called()


def test_disabled_user_is_locally_revoked_without_provider_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actor = _user(UserRole.ADMIN)
    member = _user()
    events = Mock()
    monkeypatch.setattr(account_operations, "_record_security_event", events)
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, member]
    db.scalars.return_value = []

    result = account_operations.update_user(
        member.id, UserUpdate(status=UserStatus.DISABLED), actor, db
    )

    assert result.status == UserStatus.DISABLED.value
    assert result.tokens_valid_after is not None
    db.commit.assert_called_once()
    assert [call.kwargs["outcome"].value for call in events.call_args_list] == [
        "attempt",
        "success",
    ]


def test_deleted_established_member_can_be_restored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actor = _user(UserRole.ADMIN)
    target = _user(deleted=True)
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, target]
    monkeypatch.setattr(account_operations, "_record_security_event", lambda **_kwargs: None)

    result = account_operations.restore_user(target.id, actor, db)

    assert result is target
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
    admin = _user(UserRole.ADMIN)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin, admin]

    with pytest.raises(HTTPException) as error:
        account_operations.delete_user(admin.id, admin, db)

    assert error.value.status_code == 403
    db.commit.assert_not_called()


def test_removing_last_admin_role_assignment_is_rejected() -> None:
    actor = _user(UserRole.ADMIN)
    target = _user(UserRole.ADMIN)
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, target, 1]

    with pytest.raises(HTTPException) as error:
        account_operations.update_user(
            target.id,
            UserUpdate(role=UserRole.MEMBER, status=UserStatus.DISABLED),
            actor,
            db,
        )

    assert error.value.status_code == 409
    assert target.role == UserRole.ADMIN.value


def test_local_disable_commit_failure_records_attempt_and_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    actor = _user(UserRole.ADMIN)
    target = _user()
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor, target]
    db.scalars.return_value = []
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
