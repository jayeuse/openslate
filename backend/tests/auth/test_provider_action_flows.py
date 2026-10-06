"""Verified provider email actions never admit an unbound application profile."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import Request
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.auth.router as auth_router
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    ProviderTokens,
    ProviderUser,
    SupabaseAuthUnavailable,
)
from app.systems.access.identity import provider_actions
from app.systems.access.identity.contracts import ActionTokenInvalid, InvalidCredentials
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.schemas import RecoveryRequest
from app.systems.access.users.coordination import InvitationError
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.auth.test_auth_router_contracts import _user
from tests.auth.test_mfa import mfa_context  # noqa: F401


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
        provider_actions.complete_recovery(db, "a" * 64, "Long new password", client)

    client.update_password.assert_not_called()


def test_invitation_action_cannot_activate_unbound_local_account() -> None:
    db = Mock(spec=Session)
    client = Mock()
    provider_id = uuid7()
    client.verify_email_action.return_value = ProviderTokens("access", "refresh", provider_id, 600)
    client.get_user.return_value = ProviderUser(provider_id, None, "person@example.test")
    db.scalar.return_value = None

    with pytest.raises(InvitationError):
        provider_actions.complete_invitation(db, "a" * 64, "Long new password", client)

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
            "New secure password",
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
        login_retry_after=lambda *_a: 60,
    )
    monkeypatch.setattr(provider_actions, "rate_limits", budget, raising=False)

    with pytest.raises(provider_actions.IdentityRateLimited):
        provider_actions.change_password(
            db, user, uuid7(), "access", "old password", "New secure password", client
        )

    client.password_grant.assert_not_called()


def _password_update_failure_case(failure: str):
    user = _user()
    user.supabase_user_id = uuid7()
    user.tokens_valid_after = datetime(2026, 10, 1, tzinfo=UTC)
    sessions = [
        IdentitySession(
            id=uuid7(),
            user_id=user.id,
            provider_user_id=user.supabase_user_id,
            provider_session_id=uuid7(),
            provider_access_token_encrypted="existing-encrypted-access",
            provider_refresh_token_encrypted="existing-encrypted-refresh",
            refresh_token_digest="existing-refresh-digest",
            csrf_token_digest="existing-csrf-digest",
            revoked_at=None,
            provider_signout_pending_at=None,
            provider_signout_next_attempt_at=None,
        )
        for _ in range(2)
    ]
    db = Mock(spec=Session)
    db.get.return_value = db.scalar.return_value = user
    db.scalars.return_value = sessions
    client = Mock()
    tokens = ProviderTokens("temporary-action", "temporary-refresh", user.supabase_user_id, 600)
    client.password_grant.return_value = client.verify_email_action.return_value = tokens
    client.get_user.return_value = ProviderUser(user.supabase_user_id, None, user.email)
    if failure == "wrong_subject":
        client.update_password.return_value = ProviderUser(uuid7(), None, user.email)
    else:
        client.update_password.side_effect = (
            InvalidProviderCredentials("provider rejected the password")
            if failure == "rejected"
            else SupabaseAuthUnavailable("provider unavailable")
        )
    return user, sessions, db, client


def _assert_password_failure_preserves_local_state(user, sessions, db) -> None:
    for session in sessions:
        assert session.revoked_at is None
        assert session.provider_signout_pending_at is None
        assert session.provider_signout_next_attempt_at is None
        assert session.provider_access_token_encrypted == "existing-encrypted-access"
        assert session.provider_refresh_token_encrypted == "existing-encrypted-refresh"
        assert session.refresh_token_digest == "existing-refresh-digest"
        assert session.csrf_token_digest == "existing-csrf-digest"
    assert user.tokens_valid_after == datetime(2026, 10, 1, tzinfo=UTC)
    db.commit.assert_not_called()
    db.delete.assert_not_called()


@pytest.mark.parametrize("failure", ("rejected", "unavailable", "wrong_subject"))
def test_password_change_preserves_sessions_when_provider_update_fails(failure: str) -> None:
    user, sessions, db, client = _password_update_failure_case(failure)
    expected = {
        "rejected": InvalidProviderCredentials,
        "unavailable": SupabaseAuthUnavailable,
        "wrong_subject": InvalidCredentials,
    }[failure]

    with pytest.raises(expected):
        provider_actions.change_password(
            db,
            user,
            sessions[0].id,
            "current-access",
            "old password",
            "New secure password",
            client,
            enforce_rate_limit=False,
        )

    client.update_password.assert_called_once_with("current-access", "New secure password")
    _assert_password_failure_preserves_local_state(user, sessions, db)
    client.sign_out.assert_called_once_with("temporary-action", scope="local")


@pytest.mark.parametrize("failure", ("rejected", "unavailable", "wrong_subject"))
def test_recovery_preserves_sessions_when_provider_update_fails(failure: str) -> None:
    user, sessions, db, client = _password_update_failure_case(failure)
    expected = {
        "rejected": InvalidProviderCredentials,
        "unavailable": SupabaseAuthUnavailable,
        "wrong_subject": ActionTokenInvalid,
    }[failure]

    with pytest.raises(expected):
        provider_actions.complete_recovery(db, "a" * 56, "New secure password", client)

    client.update_password.assert_called_once_with("temporary-action", "New secure password")
    _assert_password_failure_preserves_local_state(user, sessions, db)
    client.sign_out.assert_called_once_with("temporary-action", scope="local")


@pytest.mark.parametrize("password", ["Password1234!", " Password1234 ", "xPassword1234x"])
def test_password_change_preserves_unlisted_complete_candidate_before_provider_failure(
    password: str,
) -> None:
    user, sessions, db, client = _password_update_failure_case("unavailable")
    with pytest.raises(SupabaseAuthUnavailable):
        provider_actions.change_password(
            db,
            user,
            sessions[0].id,
            "current-access",
            "old password",
            password,
            client,
            enforce_rate_limit=False,
        )
    client.update_password.assert_called_once_with("current-access", password)
    _assert_password_failure_preserves_local_state(user, sessions, db)


@pytest.mark.parametrize("kind", ["invite", "recovery", "change"])
@pytest.mark.parametrize(
    "minimum,mixed,number,password,message",
    [
        (16, True, True, "ShortPassword1", "16"),
        (12, True, True, "Password1234", "common"),
        (12, False, False, "PASSWORD1234", "common"),
        (12, True, True, "Qwerty123456", "common"),
    ],
)
def test_password_policy_rejects_before_consuming_action_or_mutating_provider(
    monkeypatch: pytest.MonkeyPatch,
    kind: str,
    minimum: int,
    mixed: bool,
    number: bool,
    password: str,
    message: str,
) -> None:
    user, sessions, db, client = _password_update_failure_case("rejected")
    if kind == "invite":
        user.status = "pending"
        user.invitation_sent_at = datetime.now(UTC)
        user.provider_invitation_operation_id = uuid7()
        client.get_user.return_value = ProviderUser(
            user.supabase_user_id,
            None,
            user.email,
            app_metadata={
                "openslate_user_id": str(user.id),
                "openslate_invitation_operation_id": str(user.provider_invitation_operation_id),
            },
        )
    policy = WorkspaceProfile(
        password_min_length=minimum,
        password_require_mixed_case=mixed,
        password_require_number=number,
    )
    monkeypatch.setattr(
        provider_actions, "load_workspace_policy", lambda _db: policy, raising=False
    )

    with pytest.raises(ValueError, match=message):
        if kind == "change":
            provider_actions.change_password(
                db,
                user,
                sessions[0].id,
                "current-access",
                "old password",
                password,
                client,
                enforce_rate_limit=False,
            )
        else:
            action = (
                provider_actions.complete_invitation
                if kind == "invite"
                else provider_actions.complete_recovery
            )
            action(db, "a" * 56, password, client)

    client.verify_email_action.assert_not_called()
    client.password_grant.assert_not_called()
    client.update_password.assert_not_called()
    client.sign_out.assert_not_called()
    _assert_password_failure_preserves_local_state(user, sessions, db)


def test_mfa_policy_read_failure_after_rotation_revokes_instead_of_losing_pair(
    mfa_context,  # noqa: F811
    monkeypatch,
):
    from app.core.integrations.supabase_auth import SupabaseAuthUnavailable

    c = mfa_context
    current_policy = c.service.load_workspace_policy

    def unavailable(_db):
        if c.mfa.challenge_and_verify.called:
            raise SupabaseAuthUnavailable("policy unavailable")
        return current_policy(_db)

    monkeypatch.setattr(c.service, "load_workspace_policy", unavailable)
    with pytest.raises(SupabaseAuthUnavailable):
        c.service.verify_factor(
            c.db, c.user.id, c.session.id, c.factor_id, "123456", "old-access", c.auth
        )
    assert c.session.revoked_at is not None
    c.auth.sign_out.assert_called_once_with("new-access")


def test_verified_mfa_removal_commit_failure_attempts_durable_revocation(mfa_context):  # noqa: F811
    from sqlalchemy.exc import SQLAlchemyError

    from app.core.integrations.supabase_auth import (
        ProviderFactor,
        ProviderUser,
        SupabaseAuthUnavailable,
    )

    c = mfa_context
    c.assurance = "aal2"
    c.auth.get_user.return_value = ProviderUser(
        c.user.supabase_user_id,
        None,
        c.user.email,
        factors=(ProviderFactor(c.factor_id, "totp", "verified"),),
    )
    c.db.rollback.side_effect = lambda: setattr(c.session, "revoked_at", None)
    persisted = []

    def commit():
        if c.db.commit.call_count == 1:
            raise SQLAlchemyError("write unavailable")
        persisted.append(c.session.revoked_at)

    c.db.commit.side_effect = commit
    with pytest.raises(SupabaseAuthUnavailable):
        c.service.unenroll_factor(c.db, c.user.id, c.session.id, c.factor_id, "old-access", c.auth)
    assert persisted and persisted[0] is not None
    c.auth.sign_out.assert_called_once_with("old-access", scope="global")
