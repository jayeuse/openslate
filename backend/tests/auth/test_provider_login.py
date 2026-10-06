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
from app.systems.access.identity.contracts import InvalidCredentials, IssuedSession
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
    db.get.return_value = SimpleNamespace(user_id=uuid4())
    admit = Mock(return_value=issued)
    monkeypatch.setattr(provider_login, "admit_provider_session", admit)

    assert (
        provider_login.login_with_provider(
            db, "person@example.test", "password", client, enforce_rate_limit=False
        )
        is issued
    )
    admit.assert_called_once_with(db, tokens, client, user_agent=None)

    admit.side_effect = InvalidCredentials("unmapped")
    with pytest.raises(InvalidCredentials):
        provider_login.login_with_provider(
            db, "person@example.test", "password", client, enforce_rate_limit=False
        )
    client.sign_out.assert_called_once_with("provider-access")


def test_wrong_password_records_rate_limit_without_creating_local_session(
    monkeypatch: pytest.MonkeyPatch,
    unit_workspace_policy,
) -> None:
    from app.systems.access.identity import provider_login, rate_limits

    db = Mock(spec=Session)
    client = Mock()
    client.password_grant.side_effect = InvalidProviderCredentials("wrong")
    now = datetime.now(UTC)
    bucket = IdentityRateLimitBucket(window_started_at=now, attempt_count=0, blocked_until=None)
    monkeypatch.setattr(rate_limits, "cleanup_expired_buckets", Mock(return_value=0))
    monkeypatch.setattr(rate_limits, "login_fingerprint", Mock(return_value="fingerprint"))
    monkeypatch.setattr(rate_limits, "lock_bucket", Mock(return_value=bucket))
    record = Mock()
    monkeypatch.setattr(rate_limits, "record_attempt", record)
    with pytest.raises(InvalidCredentials):
        provider_login.login_with_provider(
            db, "person@example.test", "wrong", client, source="127.0.0.1", now=now
        )

    record.assert_called_once_with(
        db, "fingerprint", bucket, now, policy=unit_workspace_policy, login=True, source="127.0.0.1"
    )
    assert all(not isinstance(call.args[0], IdentitySession) for call in db.add.call_args_list)
