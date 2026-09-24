"""Behavior coverage for user administration after local Identity cutover."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.acceptance as invitation_acceptance
import app.systems.access.users.service as user_service
from app.systems.access.identity.models import ActionTokenPurpose
from app.systems.access.policy.service import CreationDefaults
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.models import (
    IdentityKind,
    Role,
    User,
    UserRole,
    UserStatus,
)
from app.systems.access.users.schemas import InvitationCreate
from app.systems.manage.audit.models import SecurityEventOutcome


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
    monkeypatch.setattr(user_service, "load_invitation_expiry_days", lambda _db: 7)

    result = user_service.resend_invitation_delivery(
        db, pending.id, actor_id=admin.id, delivery="email", temporary_password=None
    )

    assert result.delivery == "email"
    replace.assert_called_once_with(db, pending, "rotated-secret-123", temporary=True)
    issue.assert_called_once_with(
        db,
        pending.id,
        ActionTokenPurpose.INVITATION,
        created_by=admin.id,
        invitation_lifetime=timedelta(days=7),
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
    monkeypatch.setattr(user_service, "load_invitation_expiry_days", lambda _db: 7)
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
