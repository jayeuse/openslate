"""Behavior coverage for user administration after local Identity cutover."""

from unittest.mock import Mock

import pytest
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.service as user_service
from app.core.integrations.supabase_auth import ProviderUser, SupabaseAuthUnavailable
from app.systems.access.users.coordination import InvitationConflict, InvitationError
from app.systems.access.users.models import User, UserStatus
from app.systems.access.users.schemas import InvitationCreate
from tests.users.user_support import local_user


def _invitation() -> InvitationCreate:
    return InvitationCreate(email="person@example.com", username="person")


pytestmark = pytest.mark.usefixtures("local_identity_security_events")


def test_invitation_requires_actor_outside_bootstrap() -> None:
    with pytest.raises(InvitationError, match="actor is required"):
        user_service.invite_user(Mock(spec=Session), _invitation())


def test_invitation_rejects_duplicate_email_or_username() -> None:
    db = Mock(spec=Session)
    db.scalar.side_effect = [local_user()]

    with pytest.raises(InvitationConflict):
        user_service.invite_user(db, _invitation(), bootstrap=True)

    db.commit.assert_not_called()


def test_invitation_keeps_duplicate_conflict_when_failure_audit_cannot_persist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    db.scalar.side_effect = [local_user()]
    monkeypatch.setattr(
        user_service,
        "_security_event",
        Mock(side_effect=InvitationError("audit unavailable")),
    )

    with pytest.raises(InvitationConflict):
        user_service.invite_user(db, _invitation(), bootstrap=True)

    db.rollback.assert_called_once()


def _initial_invitation(monkeypatch: pytest.MonkeyPatch):
    db = Mock(spec=Session)
    db.scalar.side_effect = [None]
    provider = Mock()
    outcomes = []
    monkeypatch.setattr(
        user_service,
        "_security_event",
        lambda *, outcome, **_kwargs: outcomes.append(outcome.value),
    )
    monkeypatch.setattr(user_service, "append_security_event", Mock())

    def profile():
        return next(
            call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], User)
        )

    def assign_identity():
        profile().id = uuid7()

    def create(email, local_id, operation_id):
        assert db.commit.call_count == 1
        user = ProviderUser(
            uuid7(),
            None,
            email,
            {
                "openslate_user_id": str(local_id),
                "openslate_invitation_operation_id": str(operation_id),
            },
        )
        provider_id.append(user.id)
        return user

    def send(email):
        return ProviderUser(provider_id[0], None, email)

    provider_id = []

    provider.admin_create_invitation_user.side_effect = create
    provider.admin_send_invitation.side_effect = send
    db.flush.side_effect = assign_identity
    monkeypatch.setattr(user_service, "get_user", lambda *_args: profile())
    return db, provider, outcomes


def test_initial_reservation_commit_failure_never_calls_provider(monkeypatch):
    db, provider, outcomes = _initial_invitation(monkeypatch)
    db.commit.side_effect = SQLAlchemyError("commit unavailable")
    with pytest.raises(InvitationConflict):
        user_service.invite_user(db, _invitation(), bootstrap=True, client=provider)
    db.rollback.assert_called_once()
    provider.admin_create_invitation_user.assert_not_called()
    assert outcomes == ["failure"]


def test_email_invitation_commits_pending_reservation_then_correlated_success(monkeypatch):
    db, provider, outcomes = _initial_invitation(monkeypatch)
    result = user_service.invite_user(db, _invitation(), bootstrap=True, client=provider)
    assert result.status == UserStatus.PENDING.value
    assert result.supabase_user_id is not None
    assert result.invitation_sent_at is not None
    event = user_service.append_security_event.call_args.args[1]
    assert event.event_type == "user.invitation"
    assert event.outcome.value == "success"
    assert event.operation_id == result.provider_invitation_operation_id
    assert event.subject_id == result.id
    assert db.commit.call_count == 2
    assert outcomes == []


@pytest.mark.parametrize("failure", ["audit", "binding_commit", "provider_delivery"])
def test_initial_delivery_failure_preserves_reservation_without_reporting_success(
    monkeypatch, failure
):
    db, provider, outcomes = _initial_invitation(monkeypatch)
    if failure == "audit":
        user_service.append_security_event.side_effect = SQLAlchemyError("audit unavailable")
    elif failure == "binding_commit":
        db.commit.side_effect = [None, SQLAlchemyError("commit unavailable")]
    else:
        provider.admin_send_invitation.side_effect = SupabaseAuthUnavailable("unavailable")
    with pytest.raises(InvitationError, match="Unable to send invitation"):
        user_service.invite_user(db, _invitation(), bootstrap=True, client=provider)
    db.rollback.assert_called_once()
    assert outcomes == ["failure"]
    assert db.commit.call_count == (2 if failure == "binding_commit" else 1)
