"""Account-security behavior for users with local Identity credentials."""

from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.account_operations as account_operations
import app.systems.access.users.service as user_service
from app.systems.access.identity.models import ActionTokenPurpose
from app.systems.access.identity.service import ActionTokenInvalid, consume_action_token
from app.systems.access.users.models import Role, UserRole, UserStatus
from app.systems.access.users.roles_router import delete_role, update_role
from app.systems.access.users.schemas import RoleUpdate, UserUpdate
from app.systems.access.users.service import InvitationError
from tests.users.test_local_identity_users import _role, _user

pytestmark = pytest.mark.usefixtures("local_identity_security_events")


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_account_security_state_changes_invalidate_action_tokens(
    monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    admin_role = _role(UserRole.ADMIN)
    actor = _user(admin_role)
    member = _user(_role())
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, actor, member]
    db.scalars.return_value = []
    invalidate = Mock()
    monkeypatch.setattr(account_operations, "invalidate_action_tokens", invalidate)
    monkeypatch.setattr(account_operations, "_record_security_event", lambda **_kwargs: None)

    if operation == "disable":
        account_operations.update_user(member.id, UserUpdate(status=UserStatus.DISABLED), actor, db)
    else:
        account_operations.delete_user(member.id, actor, db)

    invalidate.assert_called_once_with(db, member.id)


def test_temporary_resend_maps_common_password_to_a_safe_domain_error() -> None:
    admin_role = _role(UserRole.ADMIN)
    admin = _user(admin_role)
    pending = _user(_role(), status=UserStatus.PENDING)
    credential = Mock()
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, pending]
    db.get.return_value = credential

    with pytest.raises(InvitationError, match="Temporary password"):
        user_service.resend_invitation_delivery(
            db,
            pending.id,
            actor_id=admin.id,
            delivery="temporary_password",
            temporary_password="passwordpassword",
        )

    db.rollback.assert_called_once()


def test_resend_invalidates_the_previous_invitation_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin_role = _role(UserRole.ADMIN)
    admin = _user(admin_role)
    member = _role()
    pending = _user(member, status=UserStatus.PENDING)
    pending.invitation_sent_at = datetime.now(UTC)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, pending]
    issued = Mock(return_value="replacement")
    monkeypatch.setattr(user_service, "issue_action_token", issued)

    result = user_service.resend_invitation(db, pending.id, actor_id=admin.id)

    assert result is pending
    issued.assert_called_once_with(
        db, pending.id, ActionTokenPurpose.INVITATION, created_by=admin.id
    )
    db.commit.assert_called_once()


def test_resend_rejects_non_pending_or_deleted_profiles() -> None:
    admin_role = _role(UserRole.ADMIN)
    admin = _user(admin_role)
    active = _user(_role())
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, active]

    with pytest.raises(InvitationError, match="not pending"):
        user_service.resend_invitation(db, active.id, actor_id=admin.id)

    db.commit.assert_not_called()


def test_consumed_or_expired_action_token_cannot_complete_twice() -> None:
    action = Mock()
    action.purpose = ActionTokenPurpose.INVITATION
    action.consumed_at = datetime.now(UTC)
    action.expires_at = datetime.now(UTC)
    db = Mock(spec=Session)
    db.scalar.return_value = action

    with pytest.raises(ActionTokenInvalid):
        consume_action_token(db, "raw", ActionTokenPurpose.INVITATION)


def test_pending_user_cannot_be_enabled_or_disabled_by_administrator() -> None:
    admin_role = _role(UserRole.ADMIN)
    admin = _user(admin_role)
    pending = _user(_role(), status=UserStatus.PENDING)
    for requested in (UserStatus.ACTIVE, UserStatus.DISABLED):
        db = Mock(spec=Session)
        db.scalar.side_effect = [admin_role, admin, pending]
        with pytest.raises(HTTPException) as error:
            account_operations.update_user(pending.id, UserUpdate(status=requested), admin, db)
        assert error.value.status_code == 409


def test_last_active_admin_cannot_be_deleted() -> None:
    admin_role = _role(UserRole.ADMIN)
    actor = _user(admin_role)
    target = _user(admin_role)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, actor, target, 1]

    with pytest.raises(HTTPException) as error:
        account_operations.delete_user(target.id, actor, db)

    assert error.value.status_code == 409
    assert target.is_deleted is False


def test_disabled_user_is_locally_revoked_without_provider_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin_role = _role(UserRole.ADMIN)
    actor = _user(admin_role)
    member = _user(_role())
    events = Mock()
    monkeypatch.setattr(account_operations, "_record_security_event", events)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, actor, member]
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


def test_deleted_established_user_can_be_restored_with_an_active_role(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin_role = _role(UserRole.ADMIN)
    actor = _user(admin_role)
    member_role = _role()
    target = _user(member_role, deleted=True)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, actor, target, member_role, member_role, 1]
    monkeypatch.setattr(account_operations, "_record_security_event", lambda **_kwargs: None)

    result = account_operations.restore_user(target.id, actor, db)

    assert result is target
    assert target.is_deleted is False
    assert target.status == UserStatus.ACTIVE.value
    db.commit.assert_called_once()


def test_built_in_role_cannot_be_renamed() -> None:
    admin_role = _role(UserRole.ADMIN)
    admin = _user(admin_role)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, admin_role]

    with pytest.raises(HTTPException) as error:
        update_role(admin_role.id, RoleUpdate(role="superadmin"), admin, db)

    assert error.value.status_code == 403
    db.commit.assert_not_called()


def test_empty_user_or_role_patch_is_rejected_before_database_work() -> None:
    db = Mock(spec=Session)

    with pytest.raises(HTTPException) as user_error:
        account_operations.update_user(uuid7(), UserUpdate(), Mock(), db)
    with pytest.raises(HTTPException) as role_error:
        update_role(uuid7(), RoleUpdate(), Mock(), db)

    assert user_error.value.status_code == 422
    assert role_error.value.status_code == 422
    db.scalar.assert_not_called()


def test_role_with_non_deleted_user_cannot_be_archived() -> None:
    admin_role = _role(UserRole.ADMIN)
    admin = _user(admin_role)
    editor = Role(id=uuid7(), role="editor", permissions={}, is_deleted=False)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, editor, 1]

    with pytest.raises(HTTPException) as error:
        delete_role(editor.id, admin, db)

    assert error.value.status_code == 409
    assert editor.is_deleted is False


def test_user_cannot_delete_their_own_account() -> None:
    admin_role = _role(UserRole.ADMIN)
    admin = _user(admin_role)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, admin]

    with pytest.raises(HTTPException) as error:
        account_operations.delete_user(admin.id, admin, db)

    assert error.value.status_code == 403
    db.commit.assert_not_called()


def test_removing_last_admin_role_assignment_is_rejected() -> None:
    admin_role = _role(UserRole.ADMIN)
    member_role = _role()
    actor = _user(admin_role)
    target = _user(admin_role)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, actor, target, member_role, 1]

    with pytest.raises(HTTPException) as error:
        account_operations.update_user(
            target.id,
            UserUpdate(role_id=member_role.id, status=UserStatus.DISABLED),
            actor,
            db,
        )

    assert error.value.status_code == 409
    assert target.role_id == admin_role.id


def test_local_disable_commit_failure_records_attempt_and_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    admin_role = _role(UserRole.ADMIN)
    actor = _user(admin_role)
    target = _user(_role())
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, actor, target]
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
