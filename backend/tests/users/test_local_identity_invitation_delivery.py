"""Provider email resend retains application audit and authorization outcomes."""

from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.acceptance as invitation_acceptance
import app.systems.access.users.service as user_service
from app.core.integrations.supabase_auth import ProviderUser, SupabaseAuthUnavailable
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.models import User, UserStatus
from app.systems.manage.audit.models import SecurityEventOutcome


def _resend(monkeypatch):
    actor_id = uuid7()
    profile = User(
        id=uuid7(),
        email="pending@example.test",
        username="pending",
        status=UserStatus.PENDING.value,
        is_deleted=False,
        supabase_user_id=uuid7(),
        provider_invitation_operation_id=uuid7(),
        invitation_sent_at=datetime.now(UTC),
    )
    provider_user = ProviderUser(
        profile.supabase_user_id,
        None,
        profile.email,
        {
            "openslate_user_id": str(profile.id),
            "openslate_invitation_operation_id": str(profile.provider_invitation_operation_id),
        },
    )
    client = Mock()
    client.get_admin_user.return_value = provider_user
    client.admin_send_invitation.return_value = provider_user
    monkeypatch.setattr(user_service, "require_fresh_exact_admin", lambda *_args: None)
    # The profile lock and the reload after commit both read the profile.
    db = Mock(spec=Session)
    db.scalar.return_value = profile
    events = []
    monkeypatch.setattr(user_service, "_security_event", lambda **event: events.append(event))
    monkeypatch.setattr(
        user_service, "append_security_event", lambda _db, event: events.append(event.model_dump())
    )
    return db, actor_id, profile, client, events


def test_email_resend_records_attempt_and_commits_correlated_success(monkeypatch):
    db, actor, profile, client, events = _resend(monkeypatch)
    result = user_service.resend_invitation(db, profile.id, actor_id=actor, client=client)
    assert result is profile
    assert [event["outcome"] for event in events] == [
        SecurityEventOutcome.ATTEMPT,
        SecurityEventOutcome.SUCCESS,
    ]
    assert {event["event_type"] for event in events} == {"user.invitation_resend"}
    assert events[0]["operation_id"] == events[1]["operation_id"]
    assert all(event["actor_id"] == actor and event["subject_id"] == profile.id for event in events)
    db.commit.assert_called_once()


def test_provider_resend_failure_records_failure_without_advancing_local_delivery(monkeypatch):
    db, actor, profile, client, events = _resend(monkeypatch)
    original_delivery = profile.invitation_sent_at
    client.admin_send_invitation.side_effect = SupabaseAuthUnavailable("offline")
    with pytest.raises(InvitationError, match="Unable to resend invitation"):
        user_service.resend_invitation(db, profile.id, actor_id=actor, client=client)
    assert [event["outcome"] for event in events] == [
        SecurityEventOutcome.ATTEMPT,
        SecurityEventOutcome.FAILURE,
    ]
    assert events[0]["operation_id"] == events[1]["operation_id"]
    assert profile.invitation_sent_at == original_delivery
    db.rollback.assert_called_once()
    db.commit.assert_not_called()


def test_fresh_authorization_denial_is_audited_without_rewriting_http_status(monkeypatch):
    db, actor, profile, client, events = _resend(monkeypatch)
    denied = HTTPException(status_code=403, detail="Forbidden")
    monkeypatch.setattr(user_service, "require_fresh_exact_admin", Mock(side_effect=denied))
    with pytest.raises(HTTPException) as error:
        user_service.resend_invitation(db, profile.id, actor_id=actor, client=client)
    assert error.value is denied
    assert [event["outcome"] for event in events] == [
        SecurityEventOutcome.ATTEMPT,
        SecurityEventOutcome.FAILURE,
    ]
    client.admin_send_invitation.assert_not_called()
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
