"""Behavior coverage for user administration after local Identity cutover."""

from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.auth.router as auth_router
import app.systems.access.users.acceptance as invitation_acceptance
import app.systems.access.users.account_operations as account_operations
import app.systems.access.users.service as user_service
from app.systems.access.identity.models import ActionTokenPurpose
from app.systems.access.identity.service import ActionTokenInvalid, consume_action_token
from app.systems.access.users.models import Role, User, UserRole, UserStatus
from app.systems.access.users.roles_router import delete_role, update_role
from app.systems.access.users.schemas import InvitationCreate, RoleUpdate, UserUpdate
from app.systems.access.users.service import InvitationConflict, InvitationError
from app.systems.manage.audit.models import SecurityEventOutcome


def _role(name: UserRole = UserRole.MEMBER) -> Role:
    return Role(id=uuid7(), role=name, permissions={}, is_deleted=False)


def _user(role: Role, *, status: UserStatus = UserStatus.ACTIVE, deleted: bool = False) -> User:
    now = datetime.now(UTC)
    return User(
        id=uuid7(),
        email=f"{uuid7().hex}@example.com",
        username=f"user_{uuid7().hex[:12]}",
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


@pytest.fixture(autouse=True)
def _security_events(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(user_service, "_security_event", lambda **_kwargs: None)


def test_invitation_requires_actor_outside_bootstrap() -> None:
    with pytest.raises(InvitationError, match="actor is required"):
        user_service.invite_user(Mock(spec=Session), _invitation())


def test_invitation_rejects_duplicate_email_or_username() -> None:
    db = Mock(spec=Session)
    db.scalar.side_effect = [_role(), _user(_role())]

    with pytest.raises(InvitationConflict):
        user_service.invite_user(db, _invitation(), bootstrap=True)

    db.commit.assert_not_called()


def test_invitation_keeps_duplicate_conflict_when_failure_audit_cannot_persist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    db.scalar.side_effect = [_role(), _user(_role())]
    monkeypatch.setattr(
        user_service,
        "_security_event",
        Mock(side_effect=InvitationError("audit unavailable")),
    )

    with pytest.raises(InvitationConflict):
        user_service.invite_user(db, _invitation(), bootstrap=True)

    db.rollback.assert_called_once()


def test_initial_invitation_commit_failure_rolls_back_without_reporting_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    member = _role()
    db = Mock(spec=Session)
    db.scalar.side_effect = [member, None]
    monkeypatch.setattr(db, "flush", lambda: None)
    monkeypatch.setattr(user_service, "create_credential", Mock())
    monkeypatch.setattr(user_service, "append_security_event", Mock())
    outcomes: list[str] = []
    monkeypatch.setattr(
        user_service,
        "_security_event",
        lambda *, outcome, **_kwargs: outcomes.append(outcome.value),
    )
    db.commit.side_effect = SQLAlchemyError("commit unavailable")

    with pytest.raises(InvitationConflict):
        user_service.invite_user(
            db,
            _invitation(),
            bootstrap=True,
            temporary_password="initial temporary password",
        )

    db.rollback.assert_called_once()
    assert outcomes == ["failure"]


def test_temporary_password_invitation_creates_no_unused_action_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    member = _role()
    db = Mock(spec=Session)
    db.scalar.side_effect = [member, None]
    created = Mock()
    issued = Mock(return_value="raw-invite-token")
    monkeypatch.setattr(user_service, "create_credential", created)
    monkeypatch.setattr(user_service, "issue_action_token", issued)
    monkeypatch.setattr(db, "flush", lambda: None)

    user_service.invite_user(db, _invitation(), bootstrap=True)

    assert db.add.call_count >= 1
    created.assert_called_once()
    assert created.call_args.kwargs["temporary"] is True
    issued.assert_not_called()
    db.commit.assert_called_once()


def test_email_invitation_issues_one_local_action_token(monkeypatch: pytest.MonkeyPatch) -> None:
    member = _role()
    db = Mock(spec=Session)
    db.scalar.side_effect = [member, None]
    monkeypatch.setattr(user_service, "create_credential", Mock())
    issued = Mock(return_value="raw-invite-token")
    queued = Mock()
    monkeypatch.setattr(user_service, "issue_action_token", issued)
    monkeypatch.setattr(user_service, "queue_action_delivery", queued)
    monkeypatch.setattr(user_service, "smtp_delivery_enabled", lambda: True)
    monkeypatch.setattr(db, "flush", lambda: None)
    payload = _invitation().model_copy(update={"delivery": "email"})

    user_service.invite_user(db, payload, bootstrap=True, delivery="email")

    issued.assert_called_once()
    assert issued.call_args.args[2] is ActionTokenPurpose.INVITATION
    queued.assert_called_once()
    assert queued.call_args.args[0] is db
    assert queued.call_args.args[3] == "raw-invite-token"


def test_initial_invitation_appends_success_before_committing_user_and_credential(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    member = _role()
    db = Mock(spec=Session)
    db.scalar.side_effect = [member, None]
    monkeypatch.setattr(db, "flush", lambda: None)
    credential = Mock()

    def create_credential(database, *_args, **_kwargs) -> None:
        database.add(credential)

    monkeypatch.setattr(user_service, "create_credential", create_credential)
    calls: list[str] = []
    monkeypatch.setattr(
        user_service,
        "append_security_event",
        lambda *_args: calls.append("success"),
    )
    db.commit.side_effect = lambda: calls.append("commit")

    user_service.invite_user(
        db,
        _invitation(),
        bootstrap=True,
        temporary_password="initial temporary password",
    )

    assert calls == ["success", "commit"]
    assert credential in [call.args[0] for call in db.add.call_args_list]


def test_initial_invitation_rolls_back_user_and_credential_when_success_audit_cannot_append(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    member = _role()
    db = Mock(spec=Session)
    db.scalar.side_effect = [member, None]
    monkeypatch.setattr(db, "flush", lambda: None)
    credential = Mock()

    def create_credential(database, *_args, **_kwargs) -> None:
        database.add(credential)

    monkeypatch.setattr(user_service, "create_credential", create_credential)
    monkeypatch.setattr(
        user_service,
        "append_security_event",
        Mock(side_effect=SQLAlchemyError("audit unavailable")),
    )
    outcomes: list[str] = []
    monkeypatch.setattr(
        user_service,
        "_security_event",
        lambda *, outcome, **_kwargs: outcomes.append(outcome.value),
    )

    with pytest.raises(InvitationConflict):
        user_service.invite_user(
            db,
            _invitation(),
            bootstrap=True,
            temporary_password="initial temporary password",
        )

    assert credential in [call.args[0] for call in db.add.call_args_list]
    db.rollback.assert_called_once()
    db.commit.assert_not_called()
    assert outcomes == ["failure"]


def test_email_invitation_is_rejected_without_smtp_before_creating_a_user(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    member = _role()
    db = Mock(spec=Session)
    db.scalar.return_value = member
    monkeypatch.setattr(user_service, "smtp_delivery_enabled", lambda: False)
    payload = _invitation().model_copy(update={"delivery": "email"})

    with pytest.raises(InvitationError, match="Email delivery is unavailable"):
        user_service.invite_user(db, payload, bootstrap=True, delivery="email")

    db.add.assert_not_called()
    db.commit.assert_not_called()


def test_generated_temporary_password_is_returned_once_to_the_inviter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    invited = _user(_role(), status=UserStatus.PENDING)
    create = Mock(return_value=invited)
    monkeypatch.setattr(user_service, "invite_user", create)
    monkeypatch.setattr(
        user_service, "generated_temporary_password", lambda: "generated-secret-123"
    )

    result = user_service.create_invitation(Mock(spec=Session), _invitation(), actor_id=uuid7())

    assert result.user is invited
    assert result.delivery == "temporary_password"
    assert result.temporary_password == "generated-secret-123"
    assert create.call_args.kwargs["temporary_password"] == "generated-secret-123"


def test_invitation_maps_common_temporary_password_to_a_safe_domain_error() -> None:
    member = _role()
    db = Mock(spec=Session)
    db.scalar.side_effect = [member, None]
    db.flush.side_effect = None
    payload = _invitation().model_copy(update={"temporary_password": "passwordpassword"})

    with pytest.raises(InvitationError, match="Temporary password"):
        user_service.invite_user(db, payload, bootstrap=True, temporary_password="passwordpassword")

    db.rollback.assert_called_once()


def test_invitation_route_maps_common_temporary_password_to_a_safe_4xx() -> None:
    admin_role = _role(UserRole.ADMIN)
    admin = _user(admin_role)
    member = _role()
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, member, None]
    db.flush.side_effect = None
    payload = _invitation().model_copy(update={"temporary_password": "passwordpassword"})

    with pytest.raises(HTTPException) as error:
        auth_router.invite(payload, admin, db)

    assert error.value.status_code == 409
    db.rollback.assert_called_once()


def test_temporary_resend_rotates_local_secret_without_an_action_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin_role = _role(UserRole.ADMIN)
    admin = _user(admin_role)
    pending = _user(_role(), status=UserStatus.PENDING)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, pending]
    monkeypatch.setattr(user_service, "generated_temporary_password", lambda: "next-secret-123")
    tokens = Mock()
    monkeypatch.setattr(user_service, "issue_action_token", tokens)
    replace = Mock()
    monkeypatch.setattr(user_service, "replace_password", replace)

    result = user_service.resend_invitation_delivery(
        db,
        pending.id,
        actor_id=admin.id,
        delivery="temporary_password",
        temporary_password=None,
    )

    assert result.temporary_password == "next-secret-123"
    replace.assert_called_once_with(db, pending, "next-secret-123", temporary=True)
    tokens.assert_not_called()


def test_email_resend_rotates_the_old_temporary_password_and_setup_sessions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin_role = _role(UserRole.ADMIN)
    admin = _user(admin_role)
    pending = _user(_role(), status=UserStatus.PENDING)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, admin, pending]
    monkeypatch.setattr(user_service, "smtp_delivery_enabled", lambda: True)
    monkeypatch.setattr(user_service, "generated_temporary_password", lambda: "rotated-secret-123")
    replace = Mock()
    issue = Mock(return_value="fresh-token")
    queue = Mock()
    monkeypatch.setattr(user_service, "replace_password", replace)
    monkeypatch.setattr(user_service, "issue_action_token", issue)
    monkeypatch.setattr(user_service, "queue_action_delivery", queue)

    result = user_service.resend_invitation_delivery(
        db, pending.id, actor_id=admin.id, delivery="email", temporary_password=None
    )

    assert result.delivery == "email"
    replace.assert_called_once_with(db, pending, "rotated-secret-123", temporary=True)
    issue.assert_called_once_with(
        db, pending.id, ActionTokenPurpose.INVITATION, created_by=admin.id
    )
    queue.assert_called_once_with(db, pending.id, ActionTokenPurpose.INVITATION, "fresh-token")


@pytest.mark.parametrize("delivery", ["email", "temporary_password"])
def test_delivery_resend_records_attempt_and_commits_success_with_credential_rotation(
    monkeypatch: pytest.MonkeyPatch, delivery: str
) -> None:
    admin = _user(_role(UserRole.ADMIN))
    pending = _user(_role(), status=UserStatus.PENDING)
    db = Mock(spec=Session)
    calls: list[str] = []
    db.commit.side_effect = lambda: calls.append("commit")
    monkeypatch.setattr(user_service, "require_fresh_exact_admin", lambda *_args: admin)
    monkeypatch.setattr(user_service, "_lock_profile", lambda *_args: pending)
    monkeypatch.setattr(user_service, "smtp_delivery_enabled", lambda: True)
    monkeypatch.setattr(user_service, "generated_temporary_password", lambda: "rotated-secret-123")
    monkeypatch.setattr(user_service, "replace_password", Mock())
    monkeypatch.setattr(user_service, "issue_action_token", Mock(return_value="fresh-token"))
    monkeypatch.setattr(user_service, "queue_action_delivery", Mock())
    events: list[str] = []
    monkeypatch.setattr(
        user_service,
        "_security_event",
        lambda *, outcome, **_kwargs: events.append(outcome.value),
    )
    monkeypatch.setattr(
        user_service,
        "append_security_event",
        lambda *_args: calls.append("success"),
    )

    user_service.resend_invitation_delivery(
        db,
        pending.id,
        actor_id=admin.id,
        delivery=delivery,
        temporary_password=None,
    )

    assert events == ["attempt"]
    assert calls == ["success", "commit"]


def test_delivery_resend_records_failure_without_committing_a_partial_rotation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin = _user(_role(UserRole.ADMIN))
    pending = _user(_role(), status=UserStatus.PENDING)
    db = Mock(spec=Session)
    monkeypatch.setattr(user_service, "require_fresh_exact_admin", lambda *_args: admin)
    monkeypatch.setattr(user_service, "_lock_profile", lambda *_args: pending)
    monkeypatch.setattr(user_service, "smtp_delivery_enabled", lambda: True)
    monkeypatch.setattr(user_service, "generated_temporary_password", lambda: "rotated-secret-123")
    monkeypatch.setattr(user_service, "replace_password", Mock())
    monkeypatch.setattr(
        user_service,
        "issue_action_token",
        Mock(side_effect=InvitationError("token creation failed")),
    )
    events: list[str] = []
    monkeypatch.setattr(
        user_service,
        "_security_event",
        lambda *, outcome, **_kwargs: events.append(outcome.value),
    )

    with pytest.raises(InvitationError, match="Unable to resend invitation"):
        user_service.resend_invitation_delivery(
            db,
            pending.id,
            actor_id=admin.id,
            delivery="email",
            temporary_password=None,
        )

    assert events == ["attempt", "failure"]
    db.rollback.assert_called_once()
    db.commit.assert_not_called()


def test_delivery_resend_records_fresh_authorization_failure_without_rewriting_http_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin = _user(_role(UserRole.ADMIN))
    db = Mock(spec=Session)
    authorization_error = HTTPException(status_code=403, detail="Forbidden")
    events: list[str] = []
    monkeypatch.setattr(
        user_service,
        "require_fresh_exact_admin",
        Mock(side_effect=authorization_error),
    )
    monkeypatch.setattr(
        user_service,
        "_security_event",
        lambda *, outcome, **_kwargs: events.append(outcome.value),
    )

    with pytest.raises(HTTPException) as error:
        user_service.resend_invitation_delivery(
            db,
            uuid7(),
            actor_id=admin.id,
            delivery="temporary_password",
            temporary_password=None,
        )

    assert error.value is authorization_error
    assert events == ["attempt", "failure"]
    db.rollback.assert_called_once()
    db.commit.assert_not_called()


def test_invitation_acceptance_audit_helpers_preserve_attempt_success_and_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id = uuid7()
    db = Mock(spec=Session)
    recorded: list[tuple[SecurityEventOutcome, str | None]] = []
    appended = Mock()
    monkeypatch.setattr(
        invitation_acceptance,
        "_security_event",
        lambda *, outcome, reason=None, **_kwargs: recorded.append((outcome, reason)),
    )
    monkeypatch.setattr(invitation_acceptance, "append_security_event", appended)

    operation_id = invitation_acceptance.begin_invitation_acceptance(user_id)
    invitation_acceptance.append_invitation_acceptance_success(db, operation_id, user_id)
    invitation_acceptance.record_invitation_acceptance_failure(
        operation_id, user_id, "token is invalid"
    )

    assert recorded == [
        (SecurityEventOutcome.ATTEMPT, None),
        (SecurityEventOutcome.FAILURE, "token is invalid"),
    ]
    payload = appended.call_args.args[1]
    assert payload.event_type == "user.invitation_acceptance"
    assert payload.outcome is SecurityEventOutcome.SUCCESS
    assert payload.operation_id == operation_id


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
    from sqlalchemy.exc import SQLAlchemyError

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
