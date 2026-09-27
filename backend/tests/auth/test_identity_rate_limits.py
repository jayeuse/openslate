"""Durable backend admission budgets around provider authentication."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from pydantic import SecretStr
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentityRateLimitBucket
from app.systems.access.identity.rate_limits import (
    invitation_completion_permitted,
    record_attempt,
    recovery_request_permitted,
)


def test_expired_rate_bucket_is_reset_in_place() -> None:

    now = datetime.now(UTC)
    bucket = IdentityRateLimitBucket(
        fingerprint="fingerprint",
        attempt_count=5,
        window_started_at=now - timedelta(minutes=16),
        blocked_until=now + timedelta(minutes=1),
    )
    db = Mock(spec=Session)
    db.get.return_value = bucket

    record_attempt(db, "fingerprint", bucket, now)

    assert bucket.attempt_count == 1
    assert bucket.window_started_at == now
    assert bucket.blocked_until is None
    db.add.assert_not_called()


def test_rate_limit_fingerprints_use_the_stable_backend_security_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.systems.access.identity.rate_limits import rate_limit_fingerprint

    settings = SimpleNamespace(
        supabase_secret_key=SecretStr("first-provider-key"),
        security_event_server_key=SecretStr("first-backend-key"),
    )
    monkeypatch.setattr("app.systems.access.identity.rate_limits.get_settings", lambda: settings)
    first = rate_limit_fingerprint("login", "person@example.test", "127.0.0.1")
    settings.security_event_server_key = SecretStr("rotated-backend-key")
    second = rate_limit_fingerprint("login", "person@example.test", "127.0.0.1")
    assert first != second
    settings.supabase_secret_key = SecretStr("rotated-provider-key")
    assert rate_limit_fingerprint("login", "person@example.test", "127.0.0.1") == second


def test_recovery_budget_blocks_by_source_without_creating_or_rotating_a_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    now = datetime.now(UTC)
    blocked = IdentityRateLimitBucket(
        fingerprint="source",
        attempt_count=5,
        window_started_at=now,
        blocked_until=now + timedelta(minutes=15),
    )
    db = Mock(spec=Session)
    db.scalars.return_value = []
    monkeypatch.setattr(
        "app.systems.access.identity.rate_limits.rate_limit_fingerprint",
        lambda namespace, *_args: "recipient" if namespace.endswith("recipient") else "source",
    )
    monkeypatch.setattr(
        "app.systems.access.identity.rate_limits.lock_bucket",
        lambda _db, fingerprint: blocked if fingerprint == "source" else None,
    )
    record = Mock()
    monkeypatch.setattr("app.systems.access.identity.rate_limits.record_attempt", record)

    assert not recovery_request_permitted(
        db, "person@example.test", source="127.0.0.1", now_value=now
    )
    record.assert_not_called()


def test_invitation_completion_budget_blocks_anonymous_source_before_audit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    now = datetime.now(UTC)
    blocked = IdentityRateLimitBucket(
        fingerprint="source",
        attempt_count=5,
        window_started_at=now,
        blocked_until=now + timedelta(minutes=15),
    )
    db = Mock(spec=Session)
    db.scalars.return_value = []
    fingerprint = Mock(return_value="source")
    monkeypatch.setattr(
        "app.systems.access.identity.rate_limits.rate_limit_fingerprint", fingerprint
    )
    monkeypatch.setattr(
        "app.systems.access.identity.rate_limits.lock_bucket", lambda *_args: blocked
    )
    record = Mock()
    monkeypatch.setattr("app.systems.access.identity.rate_limits.record_attempt", record)

    assert not invitation_completion_permitted(db, source="127.0.0.1", now_value=now)
    fingerprint.assert_called_once_with("invitation-completion-source", "127.0.0.1", None)
    record.assert_not_called()


def test_recovery_budget_resets_expired_recipient_and_source_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    now = datetime.now(UTC)
    buckets = {
        "recipient": IdentityRateLimitBucket(
            fingerprint="recipient",
            attempt_count=5,
            window_started_at=now - timedelta(minutes=16),
            blocked_until=now - timedelta(seconds=1),
        ),
        "source": IdentityRateLimitBucket(
            fingerprint="source",
            attempt_count=5,
            window_started_at=now - timedelta(minutes=16),
            blocked_until=now - timedelta(seconds=1),
        ),
    }
    db = Mock(spec=Session)
    db.scalars.return_value = []
    monkeypatch.setattr(
        "app.systems.access.identity.rate_limits.rate_limit_fingerprint",
        lambda namespace, *_args: "recipient" if namespace.endswith("recipient") else "source",
    )
    monkeypatch.setattr(
        "app.systems.access.identity.rate_limits.lock_bucket",
        lambda _db, fingerprint: buckets[fingerprint],
    )

    assert recovery_request_permitted(db, "person@example.test", source="127.0.0.1", now_value=now)
    assert all(
        bucket.attempt_count == 1 and bucket.blocked_until is None for bucket in buckets.values()
    )
