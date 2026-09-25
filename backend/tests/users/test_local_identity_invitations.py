"""Behavior coverage for user administration after local Identity cutover."""

from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.auth.router as auth_router
import app.systems.access.users.service as user_service
from app.systems.access.identity.models import ActionTokenPurpose
from app.systems.access.policy.service import CreationDefaults
from app.systems.access.users.coordination import InvitationConflict, InvitationError
from app.systems.access.users.models import (
    IdentityKind,
    Role,
    User,
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
