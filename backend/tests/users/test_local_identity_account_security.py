"""Application account security with Supabase-owned authentication."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.account_operations as account_operations
import app.systems.access.users.coordination as coordination
import app.systems.access.users.roles_router as roles_router
import app.systems.access.users.service as user_service
from app.core.integrations.supabase_auth import InvalidProviderCredentials
from app.systems.access.identity.provider_actions import complete_invitation
from app.systems.access.policy.models import AccessPolicyDefaults
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.models import Role, UserRole, UserStatus
from app.systems.access.users.roles_router import delete_role, update_role
from app.systems.access.users.schemas import RoleUpdate, UserUpdate
from tests.users.test_local_identity_users import _role, _user

pytestmark = pytest.mark.usefixtures("local_identity_security_events")


@pytest.fixture(autouse=True)
def no_service_identity_references(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        account_operations, "non_deleted_service_identity_count", lambda *_args, **_kwargs: 0
    )
    monkeypatch.setattr(
        roles_router, "non_deleted_service_identity_count", lambda *_args, **_kwargs: 0
    )
    monkeypatch.setattr(
        roles_router,
        "get_defaults",
        lambda *_args, **_kwargs: AccessPolicyDefaults(
            singleton_key="workspace", default_role_id=uuid7()
        ),
    )


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_account_security_state_changes_revoke_provider_backed_sessions(
    monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    admin_role = _role(UserRole.ADMIN)
    actor = _user(admin_role)
    member = _user(_role())
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, actor, member]
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
    admin_role = _role(UserRole.ADMIN)
    admin = _user(admin_role)
    active = _user(_role(), deleted=deleted)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, active]
    provider = Mock()

    with pytest.raises(InvitationError, match="not pending"):
        user_service.resend_invitation(db, active.id, actor_id=admin.id, client=provider)

    provider.admin_send_invitation.assert_not_called()

    db.commit.assert_not_called()


def test_provider_rejected_invitation_cannot_change_account_or_password() -> None:
    db = Mock(spec=Session)
    provider = Mock()
    provider.verify_email_action.side_effect = InvalidProviderCredentials("expired or consumed")

    with pytest.raises(InvitationError, match="Invitation token is invalid"):
        complete_invitation(db, "a" * 56, "new password", provider)

    provider.update_password.assert_not_called()
    db.commit.assert_not_called()
    db.scalar.assert_not_called()


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


@pytest.mark.parametrize("expiry_offset", [-timedelta(days=1), timedelta(days=1)])
def test_last_administrator_cannot_be_given_an_expiry(expiry_offset: timedelta) -> None:
    admin_role = _role(UserRole.ADMIN)
    actor = _user(admin_role)
    target = _user(admin_role)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, actor, target, 1, 1]

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
    admin_role = _role(UserRole.ADMIN)
    actor = _user(admin_role)
    target = _user(admin_role)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, actor, target, 2, 1]
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
    admin_role = _role(UserRole.ADMIN)
    actor = _user(admin_role)
    target = _user(admin_role)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, actor, target, 2, 1]
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


@pytest.mark.parametrize("builtin_role", [UserRole.ADMIN, UserRole.MEMBER])
@pytest.mark.parametrize(
    "patch",
    [
        pytest.param({"role": "renamed"}, id="name"),
        pytest.param({"description": "Changed description"}, id="description"),
        pytest.param({"permissions": {"records.read": False}}, id="permissions"),
    ],
)
def test_every_builtin_role_patch_is_rejected_without_changes(
    builtin_role: UserRole, patch: dict[str, object]
) -> None:
    admin_role = _role(UserRole.ADMIN)
    admin = _user(admin_role)
    target = admin_role if builtin_role is UserRole.ADMIN else _role(UserRole.MEMBER)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, target]
    before = (target.role, target.description, dict(target.permissions))

    with pytest.raises(HTTPException) as error:
        update_role(target.id, RoleUpdate(**patch), admin, db)

    assert error.value.status_code == 403
    assert (target.role, target.description, dict(target.permissions)) == before
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


def test_configured_default_role_cannot_be_archived(monkeypatch: pytest.MonkeyPatch) -> None:
    admin_role = _role(UserRole.ADMIN)
    admin = _user(admin_role)
    editor = Role(id=uuid7(), role="editor", permissions={}, is_deleted=False)
    defaults = AccessPolicyDefaults(singleton_key="workspace", default_role_id=editor.id)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, editor, 0, 0]
    monkeypatch.setattr(
        roles_router, "get_defaults", lambda *_args, **_kwargs: defaults, raising=False
    )

    with pytest.raises(HTTPException) as error:
        delete_role(editor.id, admin, db)

    assert error.value.status_code == 409
    assert editor.is_deleted is False
    db.commit.assert_not_called()


def test_role_with_non_deleted_service_identity_cannot_be_archived(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin_role = _role(UserRole.ADMIN)
    admin = _user(admin_role)
    editor = Role(id=uuid7(), role="editor", permissions={}, is_deleted=False)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, editor, 0]
    monkeypatch.setattr(
        roles_router, "non_deleted_service_identity_count", lambda *_args, **_kwargs: 1
    )

    with pytest.raises(HTTPException) as error:
        delete_role(editor.id, admin, db)

    assert error.value.status_code == 409
    assert editor.is_deleted is False


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_service_identity_owner_must_reassign_before_lifecycle_change(
    monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    admin_role = _role(UserRole.ADMIN)
    admin = _user(admin_role)
    member = _user(_role())
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, member]
    monkeypatch.setattr(
        account_operations, "non_deleted_service_identity_count", lambda *_args, **_kwargs: 1
    )

    with pytest.raises(HTTPException) as error:
        if operation == "disable":
            account_operations.update_user(
                member.id, UserUpdate(status=UserStatus.DISABLED), admin, db
            )
        else:
            account_operations.delete_user(member.id, admin, db)

    assert error.value.status_code == 409
    assert member.is_deleted is False
    assert member.status == UserStatus.ACTIVE.value


def test_disable_with_profile_patch_blocks_before_any_profile_or_membership_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin_role = _role(UserRole.ADMIN)
    admin = _user(admin_role)
    member = _user(_role())
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, member]
    apply_profile = Mock()
    monkeypatch.setattr(account_operations, "_apply_profile_update", apply_profile)
    monkeypatch.setattr(
        account_operations, "non_deleted_service_identity_count", lambda *_args, **_kwargs: 1
    )

    with pytest.raises(HTTPException) as error:
        account_operations.update_user(
            member.id,
            UserUpdate(status=UserStatus.DISABLED, display_name="Changed"),
            admin,
            db,
        )

    assert error.value.status_code == 409
    apply_profile.assert_not_called()
    db.flush.assert_not_called()
    db.rollback.assert_called_once()
    assert member.display_name is None


def test_service_identity_reference_query_rolls_back_on_database_failure() -> None:
    db = Mock(spec=Session)
    db.scalar.side_effect = SQLAlchemyError("unavailable")

    with pytest.raises(HTTPException) as error:
        coordination.non_deleted_service_identity_count(db, owner_id=uuid7())

    assert error.value.status_code == 503
    db.rollback.assert_called_once()


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
