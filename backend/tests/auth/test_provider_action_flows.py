"""Verified provider email actions never admit an unbound application profile."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import Request
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.auth.router as auth_router
from app.core.integrations.supabase_auth import ProviderTokens, ProviderUser
from app.systems.access.identity import provider_actions
from app.systems.access.identity.contracts import ActionTokenInvalid, InvalidCredentials
from app.systems.access.identity.schemas import RecoveryRequest
from app.systems.access.users.coordination import InvitationError


def _request() -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/auth/recovery/request",
            "headers": [],
            "client": ("127.0.0.1", 50000),
            "scheme": "https",
            "server": ("app.example.test", 443),
        }
    )


def test_recovery_email_action_cannot_change_password_without_local_binding() -> None:
    db = Mock(spec=Session)
    client = Mock()
    provider_id = uuid7()
    client.verify_email_action.return_value = ProviderTokens("access", "refresh", provider_id, 600)
    client.get_user.return_value = ProviderUser(provider_id, None, "person@example.test")
    db.scalar.return_value = None

    with pytest.raises(ActionTokenInvalid):
        provider_actions.complete_recovery(db, "a" * 64, "long new password", client)

    client.update_password.assert_not_called()


def test_invitation_action_cannot_activate_unbound_local_account() -> None:
    db = Mock(spec=Session)
    client = Mock()
    provider_id = uuid7()
    client.verify_email_action.return_value = ProviderTokens("access", "refresh", provider_id, 600)
    client.get_user.return_value = ProviderUser(provider_id, None, "person@example.test")
    db.scalar.return_value = None

    with pytest.raises(InvitationError):
        provider_actions.complete_invitation(db, "a" * 64, "long new password", client)

    client.update_password.assert_not_called()


def test_password_change_rejects_grant_for_another_provider_identity() -> None:
    db = Mock(spec=Session)
    client = Mock()
    client.password_grant.return_value = ProviderTokens("temporary", "refresh", uuid7(), 600)
    local = Mock()
    local.id = uuid7()
    local.email = "person@example.test"
    local.supabase_user_id = uuid7()

    with pytest.raises(InvalidCredentials):
        provider_actions.change_password(
            db,
            local,
            uuid7(),
            "current-access",
            "old password",
            "new password",
            client,
            enforce_rate_limit=False,
        )

    client.update_password.assert_not_called()
    db.commit.assert_not_called()


def test_recovery_request_has_the_same_provider_path_for_unknown_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    provider = Mock()
    monkeypatch.setattr(auth_router, "get_supabase_auth_client", lambda: provider)
    monkeypatch.setattr(auth_router, "_require_browser_origin", lambda _request: None)
    monkeypatch.setattr(auth_router, "recovery_request_permitted", lambda *_a, **_kw: True)
    payload = RecoveryRequest(email="person@example.test")

    first = auth_router.request_recovery(payload, _request(), db)
    second = auth_router.request_recovery(payload, _request(), db)

    assert first.status_code == second.status_code == 204
    assert provider.request_recovery.call_count == 2


def test_password_change_stops_before_provider_grant_when_backend_budget_blocked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    client = Mock()
    user = SimpleNamespace(id=uuid7(), email="person@example.test", supabase_user_id=uuid7())
    blocked = SimpleNamespace(blocked_until=datetime.now(UTC) + timedelta(minutes=1))
    budget = SimpleNamespace(
        cleanup_expired_buckets=lambda *_a, **_kw: None,
        login_fingerprint=lambda *_a: "fingerprint",
        lock_bucket=lambda *_a: blocked,
    )
    monkeypatch.setattr(provider_actions, "rate_limits", budget, raising=False)

    with pytest.raises(provider_actions.IdentityRateLimited):
        provider_actions.change_password(
            db, user, uuid7(), "access", "old password", "new password", client
        )

    client.password_grant.assert_not_called()
