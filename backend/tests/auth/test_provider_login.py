"""Provider password exchange admission and denial behavior."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    ProviderTokens,
)
from app.systems.access.identity.contracts import (
    IdentityRateLimited,
    InvalidCredentials,
    IssuedSession,
)
from app.systems.access.identity.models import IdentityRateLimitBucket, IdentitySession


def test_password_grant_admits_only_the_bound_application_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.systems.access.identity import provider_login

    db = Mock(spec=Session)
    client = Mock()
    tokens = ProviderTokens("provider-access", "provider-refresh", uuid4(), 600)
    issued = IssuedSession("provider-access", "local-handle", "csrf", uuid4(), False)
    client.password_grant.return_value = tokens
    person_id = uuid4()
    db.get.return_value = SimpleNamespace(user_id=person_id)
    admit = Mock(return_value=issued)
    monkeypatch.setattr(provider_login, "admit_provider_session", admit)
    events = Mock()
    monkeypatch.setattr(provider_login, "append_security_event", events)
    now = datetime(2026, 10, 12, 9, 30, tzinfo=UTC)

    assert (
        provider_login.login_with_provider(
            db,
            "person@example.test",
            "password",
            client,
            source="203.0.113.7",
            user_agent="Browser/1",
            now=now,
            enforce_rate_limit=False,
        )
        is issued
    )
    client.password_grant.assert_called_once_with("person@example.test", "password")
    # The session list shows the device and address of each session.
    admit.assert_called_once_with(
        db, tokens, client, user_agent="Browser/1", ip_address="203.0.113.7"
    )
    # Without a login budget there is no bucket to clear.
    db.delete.assert_not_called()
    # The security events screen lists the sign-in of the bound person.
    event = events.call_args.args[1]
    assert (event.event_type, event.outcome, event.source) == (
        "identity.sign_in",
        "success",
        "identity.login",
    )
    assert (event.actor_id, event.subject_id, event.occurred_at) == (person_id, person_id, now)
    assert event.metadata == {"ip_address": "203.0.113.7"}

    admit.side_effect = InvalidCredentials("unmapped")
    with pytest.raises(InvalidCredentials):
        provider_login.login_with_provider(
            db, "person@example.test", "password", client, enforce_rate_limit=False
        )
    client.sign_out.assert_called_once_with("provider-access")


@pytest.mark.parametrize("refused_by", ["provider", "admission"])
def test_wrong_password_records_rate_limit_without_creating_local_session(
    monkeypatch: pytest.MonkeyPatch,
    unit_workspace_policy,
    refused_by: str,
) -> None:
    from app.systems.access.identity import provider_login, rate_limits

    db = Mock(spec=Session)
    client = Mock()
    if refused_by == "provider":
        client.password_grant.side_effect = InvalidProviderCredentials("wrong")
    else:
        # A correct provider password for an unbound or ineligible profile costs the same.
        client.password_grant.return_value = ProviderTokens("access", "refresh", uuid4(), 600)
        monkeypatch.setattr(
            provider_login,
            "admit_provider_session",
            Mock(side_effect=InvalidCredentials("unbound")),
        )
    now = datetime.now(UTC)
    bucket = IdentityRateLimitBucket(window_started_at=now, attempt_count=0, blocked_until=None)
    monkeypatch.setattr(rate_limits, "cleanup_expired_buckets", Mock(return_value=0))
    monkeypatch.setattr(rate_limits, "login_fingerprint", Mock(return_value="fingerprint"))
    monkeypatch.setattr(rate_limits, "lock_bucket", Mock(return_value=bucket))
    record = Mock()
    monkeypatch.setattr(rate_limits, "record_attempt", record)
    failures = Mock()
    monkeypatch.setattr(provider_login, "append_representative_failure", failures)
    with pytest.raises(InvalidCredentials):
        provider_login.login_with_provider(
            db, "person@example.test", "wrong", client, source="127.0.0.1", now=now
        )

    record.assert_called_once_with(
        db, "fingerprint", bucket, now, policy=unit_workspace_policy, login=True, source="127.0.0.1"
    )
    failures.assert_called_once_with(db, "identity.sign_in_failure", "127.0.0.1", now=now)
    assert all(not isinstance(call.args[0], IdentitySession) for call in db.add.call_args_list)
    db.delete.assert_not_called()


def test_a_blocked_login_budget_refuses_before_the_provider_with_the_remaining_wait(
    monkeypatch: pytest.MonkeyPatch,
    unit_workspace_policy,
) -> None:
    from app.systems.access.identity import provider_login, rate_limits

    client = Mock()
    monkeypatch.setattr(rate_limits, "cleanup_expired_buckets", Mock(return_value=0))
    monkeypatch.setattr(rate_limits, "login_fingerprint", Mock(return_value="fingerprint"))
    monkeypatch.setattr(rate_limits, "lock_bucket", Mock(return_value=Mock()))
    monkeypatch.setattr(rate_limits, "login_retry_after", Mock(return_value=60))

    with pytest.raises(IdentityRateLimited) as error:
        provider_login.login_with_provider(
            Mock(spec=Session), "person@example.test", "password", client, source="127.0.0.1"
        )

    # The route sends this wait as Retry-After.
    assert error.value.retry_after == 60
    client.password_grant.assert_not_called()
