"""Verified provider email actions never admit an unbound application profile."""

from datetime import UTC, datetime, timedelta
from functools import partial
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import Request
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.auth.request_security as request_security
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
from tests.auth.local_identity_support import contract_user


@pytest.fixture(autouse=True)
def event_writers(monkeypatch):
    # Real committed event behavior is covered by provider_outcomes_integration.
    monkeypatch.setattr(provider_actions.audit_service, "append_committed_security_event", Mock())
    monkeypatch.setattr(provider_actions.audit_service, "append_security_event", Mock())


ORIGIN = "https://app.example.test"


def _request(origin: str | None = None) -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/auth/recovery/request",
            "headers": [] if origin is None else [(b"origin", origin.encode())],
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
    # The real origin check runs against the configured public origin.
    monkeypatch.setattr(
        request_security, "get_settings", lambda: SimpleNamespace(public_origin=ORIGIN)
    )
    monkeypatch.setattr(
        provider_actions.rate_limits, "recovery_request_permitted", lambda *_a, **_kw: True
    )
    payload = RecoveryRequest(email="person@example.test")

    first = auth_router.request_recovery(payload, _request(ORIGIN), db)
    second = auth_router.request_recovery(payload, _request(ORIGIN), db)

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
        login_retry_after=lambda *_a, **_kw: 60,
    )
    monkeypatch.setattr(provider_actions, "rate_limits", budget, raising=False)

    with pytest.raises(provider_actions.IdentityRateLimited):
        provider_actions.change_password(
            db, user, uuid7(), "access", "old password", "New secure password", client
        )

    client.password_grant.assert_not_called()


def _password_update_failure_case(failure: str):
    user = contract_user()
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
    if failure == "none":
        client.update_password.return_value = ProviderUser(user.supabase_user_id, None, user.email)
    elif failure == "wrong_subject":
        client.update_password.return_value = ProviderUser(uuid7(), None, user.email)
    else:
        client.update_password.side_effect = (
            InvalidProviderCredentials("provider rejected the password")
            if failure == "rejected"
            else SupabaseAuthUnavailable("provider unavailable")
        )
    return user, sessions, db, client


def _bind_invitation(user, client) -> None:
    """A pending profile whose provider user carries this profile's invitation binding."""
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


# The terminal row of a password update that the provider may have applied.
TERMINAL = {"rejected": "failure", "unavailable": "partial", "wrong_subject": "partial"}


def _written():
    """Events committed on their own, and events written in the action's own transaction."""
    committed = provider_actions.audit_service.append_committed_security_event.call_args_list
    local = provider_actions.audit_service.append_security_event.call_args_list
    return [call.args[0] for call in committed], [call.args[1] for call in local]


def _phases(events) -> list[tuple[str, str, str | None, str | None]]:
    # The security events screen labels the event, its outcome, its stage and its reason.
    return [(e.event_type, e.outcome, e.metadata.get("stage"), e.reason) for e in events]


def _assert_one_operation(events, person_id, address) -> None:
    assert {(e.actor_id, e.subject_id, e.metadata["ip_address"], e.source) for e in events} == {
        (person_id, person_id, address, "identity.provider_action")
    }
    assert len({e.operation_id for e in events}) == 1


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
            source="203.0.113.7",
        )

    client.update_password.assert_called_once_with("current-access", "New secure password")
    _assert_password_failure_preserves_local_state(user, sessions, db)
    client.sign_out.assert_called_once_with("temporary-action", scope="local")
    committed, local = _written()
    assert _phases(committed) == [
        ("identity.password_change", "attempt", "provider_update", None),
        ("identity.password_change", TERMINAL[failure], "provider_update", None),
    ]
    assert local == []
    _assert_one_operation(committed, user.id, "203.0.113.7")


@pytest.mark.parametrize("failure", ("rejected", "unavailable", "wrong_subject"))
def test_recovery_preserves_sessions_when_provider_update_fails(failure: str) -> None:
    user, sessions, db, client = _password_update_failure_case(failure)
    expected = {
        "rejected": InvalidProviderCredentials,
        "unavailable": SupabaseAuthUnavailable,
        "wrong_subject": ActionTokenInvalid,
    }[failure]

    with pytest.raises(expected):
        provider_actions.complete_recovery(
            db, "a" * 56, "New secure password", client, source="203.0.113.7"
        )

    client.update_password.assert_called_once_with("temporary-action", "New secure password")
    _assert_password_failure_preserves_local_state(user, sessions, db)
    client.sign_out.assert_called_once_with("temporary-action", scope="local")
    committed, local = _written()
    assert _phases(committed) == [
        ("identity.recovery_complete", "attempt", "provider_update", None),
        ("identity.recovery_complete", TERMINAL[failure], "provider_update", None),
    ]
    assert local == []
    _assert_one_operation(committed, user.id, "203.0.113.7")


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
        _bind_invitation(user, client)
    policy = WorkspaceProfile(
        password_min_length=minimum,
        password_require_mixed_case=mixed,
        password_require_number=number,
    )
    monkeypatch.setattr(
        provider_actions, "load_workspace_policy", lambda _db: policy, raising=False
    )

    if kind == "change":
        attempt = partial(
            provider_actions.change_password,
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
        attempt = partial(action, db, "a" * 56, password, client)

    with pytest.raises(ValueError, match=message):
        attempt()

    client.verify_email_action.assert_not_called()
    client.password_grant.assert_not_called()
    client.update_password.assert_not_called()
    client.sign_out.assert_not_called()
    _assert_password_failure_preserves_local_state(user, sessions, db)


def test_mfa_policy_read_failure_after_rotation_revokes_instead_of_losing_pair(
    mfa_context,
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


def test_verified_mfa_removal_commit_failure_attempts_durable_revocation(mfa_context):
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


@pytest.mark.parametrize("provider_fails", [False, True])
def test_recovery_request_events_show_whether_the_provider_accepted(
    monkeypatch: pytest.MonkeyPatch, provider_fails: bool
) -> None:
    db = Mock(spec=Session)
    client = Mock()
    budget = Mock(return_value=True)
    monkeypatch.setattr(provider_actions.rate_limits, "recovery_request_permitted", budget)
    if provider_fails:
        client.request_recovery.side_effect = SupabaseAuthUnavailable("provider unavailable")
    request = partial(
        provider_actions.request_recovery,
        db,
        "person@example.test",
        client,
        source="203.0.113.7",
        enforce_rate_limit=True,
    )

    if provider_fails:
        with pytest.raises(SupabaseAuthUnavailable):
            request()
    else:
        request()

    budget.assert_called_once_with(db, "person@example.test", source="203.0.113.7")
    client.request_recovery.assert_called_once_with("person@example.test")
    committed, _local = _written()
    terminal = (
        ("identity.recovery_request", "partial", "provider_request_unconfirmed", None)
        if provider_fails
        else ("identity.recovery_request", "success", "provider_accepted", "request_accepted")
    )
    assert _phases(committed) == [
        ("identity.recovery_request", "attempt", "provider_request", None),
        terminal,
    ]
    # The requester is anonymous: no person is named, only the address.
    _assert_one_operation(committed, None, "203.0.113.7")


@pytest.mark.parametrize(("enforce", "sent"), [(True, False), (False, True)])
def test_the_recovery_budget_applies_only_while_anonymous_limits_are_on(
    monkeypatch: pytest.MonkeyPatch, enforce: bool, sent: bool
) -> None:
    client = Mock()
    exhausted = Mock(return_value=False)
    monkeypatch.setattr(provider_actions.rate_limits, "recovery_request_permitted", exhausted)

    provider_actions.request_recovery(
        Mock(spec=Session), "person@example.test", client, source=None, enforce_rate_limit=enforce
    )

    if sent:
        exhausted.assert_not_called()
        client.request_recovery.assert_called_once_with("person@example.test")
    else:
        client.request_recovery.assert_not_called()
        assert _written() == ([], [])


@pytest.mark.parametrize("kind", ["recovery", "change"])
def test_a_completed_password_update_revokes_sessions_in_the_recorded_local_commit(
    monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    user, sessions, db, client = _password_update_failure_case("none")
    bucket = Mock()
    for name, value in {
        "cleanup_expired_buckets": Mock(return_value=0),
        "login_fingerprint": Mock(return_value="fingerprint"),
        "lock_bucket": Mock(return_value=bucket),
        "login_retry_after": Mock(return_value=None),
    }.items():
        monkeypatch.setattr(provider_actions.rate_limits, name, value)

    if kind == "change":
        provider_actions.change_password(
            db,
            user,
            sessions[0].id,
            "current-access",
            "old password",
            "New secure password",
            client,
            source="203.0.113.7",
        )
        client.password_grant.assert_called_once_with(user.email, "old password")
        client.update_password.assert_called_once_with("current-access", "New secure password")
        # The session that changed the password stays; every other session ends.
        assert sessions[0].revoked_at is None and sessions[1].revoked_at is not None
        # A successful change clears the login budget of the person.
        db.delete.assert_called_once_with(bucket)
        client.sign_out.assert_called_once_with("temporary-action", scope="local")
    else:
        provider_actions.complete_recovery(
            db, "a" * 56, "New secure password", client, source="203.0.113.7"
        )
        client.update_password.assert_called_once_with("temporary-action", "New secure password")
        assert all(session.revoked_at is not None for session in sessions)
        client.sign_out.assert_called_once_with("temporary-action", scope="global")

    client.get_user.assert_called_once_with("temporary-action")
    db.commit.assert_called_once_with()
    event = f"identity.{'password_change' if kind == 'change' else 'recovery_complete'}"
    committed, local = _written()
    assert _phases(committed) == [(event, "attempt", "provider_update", None)]
    assert _phases(local) == [(event, "success", "local_commit", None)]
    _assert_one_operation(committed + local, user.id, "203.0.113.7")


@pytest.mark.parametrize(
    "refusal",
    [
        "wrong_password",
        "other_identity",
        "provider_email",
        "provider_banned",
        "local_rebound",
        "local_disabled",
        "local_expired",
    ],
)
def test_each_refused_password_change_spends_the_person_login_budget(
    monkeypatch: pytest.MonkeyPatch, unit_workspace_policy, refusal: str
) -> None:
    user, sessions, db, client = _password_update_failure_case("none")
    now = datetime(2026, 10, 12, 9, 30, tzinfo=UTC)
    monkeypatch.setattr(provider_actions, "utc_now", lambda: now)
    bucket = Mock()
    fingerprint = Mock(return_value="fingerprint")
    retry_after = Mock(return_value=None)
    record = Mock()
    for name, value in {
        "cleanup_expired_buckets": Mock(return_value=0),
        "login_fingerprint": fingerprint,
        "lock_bucket": Mock(return_value=bucket),
        "login_retry_after": retry_after,
        "record_attempt": record,
    }.items():
        monkeypatch.setattr(provider_actions.rate_limits, name, value)
    locked = SimpleNamespace(
        supabase_user_id=user.supabase_user_id, status="active", is_deleted=False, expires_at=None
    )
    db.get.return_value = locked
    if refusal == "wrong_password":
        client.password_grant.side_effect = InvalidProviderCredentials("wrong")
    elif refusal == "other_identity":
        client.password_grant.return_value = ProviderTokens("temporary-action", "r", uuid7(), 600)
    elif refusal == "provider_email":
        client.get_user.return_value = ProviderUser(user.supabase_user_id, None, "o@example.test")
    elif refusal == "provider_banned":
        client.get_user.return_value = ProviderUser(
            user.supabase_user_id, datetime(2999, 1, 1, tzinfo=UTC), user.email
        )
    elif refusal == "local_rebound":
        locked.supabase_user_id = uuid7()
    elif refusal == "local_disabled":
        locked.status = "disabled"
    else:
        locked.expires_at = datetime(2020, 1, 1, tzinfo=UTC)

    with pytest.raises(InvalidCredentials):
        provider_actions.change_password(
            db,
            user,
            sessions[0].id,
            "current-access",
            "old password",
            "New secure password",
            client,
            source="203.0.113.7",
        )

    # A password change shares the sign-in budget of the account, whatever the address.
    fingerprint.assert_called_once_with(user.email, None)
    retry_after.assert_called_once_with(
        db, bucket, now, unit_workspace_policy, source="203.0.113.7", actor_id=user.id
    )
    record.assert_called_once_with(
        db,
        "fingerprint",
        bucket,
        now,
        policy=unit_workspace_policy,
        login=True,
        source="203.0.113.7",
        actor_id=user.id,
    )
    db.commit.assert_called_once_with()
    client.update_password.assert_not_called()


@pytest.mark.parametrize(
    "mismatch",
    ["email", "status", "never_sent", "no_operation", "other_profile", "other_operation"],
)
def test_an_invitation_completes_only_for_the_exactly_bound_pending_profile(
    mismatch: str,
) -> None:
    user, _sessions, db, client = _password_update_failure_case("none")
    _bind_invitation(user, client)
    provider = client.get_user.return_value
    if mismatch == "email":
        user.email = "someone-else@example.test"
    elif mismatch == "status":
        user.status = "active"
    elif mismatch == "never_sent":
        user.invitation_sent_at = None
    elif mismatch == "no_operation":
        user.provider_invitation_operation_id = None
    elif mismatch == "other_profile":
        provider.app_metadata["openslate_user_id"] = str(uuid7())
    else:
        provider.app_metadata["openslate_invitation_operation_id"] = str(uuid7())

    with pytest.raises(InvitationError):
        provider_actions.complete_invitation(db, "a" * 56, "New secure password", client)

    client.update_password.assert_not_called()


def test_a_bound_invitation_sets_the_password_on_the_invited_provider_user(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user, _sessions, db, client = _password_update_failure_case("none")
    _bind_invitation(user, client)
    accept = Mock()
    monkeypatch.setattr(provider_actions, "accept_verified_invitation", accept)

    provider_actions.complete_invitation(db, "a" * 56, "New secure password", client)

    client.update_password.assert_called_once_with("temporary-action", "New secure password")
    accept.assert_called_once_with(
        db, user.id, verified_email=user.email, verified_identity=user.id
    )
    client.sign_out.assert_called_once_with("temporary-action", scope="global")


def test_an_email_action_for_another_provider_user_is_refused() -> None:
    user, _sessions, db, client = _password_update_failure_case("none")
    client.get_user.return_value = ProviderUser(uuid7(), None, user.email)

    with pytest.raises(ActionTokenInvalid):
        provider_actions.complete_recovery(db, "a" * 56, "New secure password", client)

    client.update_password.assert_not_called()


def test_a_login_denial_whose_budget_cannot_commit_is_reported() -> None:
    from sqlalchemy.exc import SQLAlchemyError

    db = Mock(spec=Session)
    assert provider_actions.try_commit_login_denial(db) is True

    db.commit.side_effect = SQLAlchemyError("write unavailable")
    # The route then answers 503, not a plain credential refusal.
    assert provider_actions.try_commit_login_denial(db) is False
    db.rollback.assert_called_once_with()
