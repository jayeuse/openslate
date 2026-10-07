from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import UUID

import pytest

import app.systems.sandbox.lifecycle.password as password_module
from app.core.integrations.supabase_auth import (
    ProviderTokens,
    ProviderUser,
    SupabaseAuthUnavailable,
)
from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleActorBlocked,
    LifecycleInvalidCredentials,
    LifecyclePasswordRateLimited,
    LifecyclePasswordServiceUnavailable,
)
from app.systems.sandbox.lifecycle.models import (
    LifecycleChallengeStatus,
    LifecycleConfirmationChallenge,
    LifecycleOperation,
    LifecycleRateLimitBucket,
)
from app.systems.sandbox.lifecycle.password import ProviderPasswordGrantClient
from app.systems.sandbox.lifecycle.service import begin_verification, hash_challenge_token

CHALLENGE_TOKEN = token_urlsafe(32)
CONFIRMATION_PASSWORD = token_urlsafe(32)

ACTOR_ID = UUID("00000000-0000-0000-0000-000000000123")


@pytest.fixture(autouse=True)
def unit_login_policy(request, monkeypatch):
    if request.node.get_closest_marker("integration") is None:
        from app.systems.manage.workspace.models import WorkspaceProfile

        monkeypatch.setattr(
            password_module,
            "load_workspace_policy",
            lambda _db: WorkspaceProfile(
                login_failed_attempt_threshold=5, login_window_minutes=15, login_cooldown_minutes=15
            ),
        )


def test_challenge_tokens_are_256_bit_and_only_the_hash_is_persistable() -> None:
    token = CHALLENGE_TOKEN

    digest = hash_challenge_token(token)

    assert len(digest) == 64
    assert digest != token
    assert digest == hash_challenge_token(token)


def test_in_flight_verifications_reserve_the_actor_failure_budget() -> None:
    now = datetime(2026, 8, 30, tzinfo=UTC)
    target_id = UUID("00000000-0000-0000-0000-000000000456")

    def challenge(status: LifecycleChallengeStatus) -> LifecycleConfirmationChallenge:
        item = LifecycleConfirmationChallenge(
            actor_id=ACTOR_ID,
            operation=LifecycleOperation.CLOSE,
            target_type="department",
            target_id=target_id,
            impact_digest="impact",
            token_hash="a" * 64,
            status=status,
            created_at=now,
            updated_at=now,
            expires_at=now + timedelta(minutes=5),
        )
        if status is LifecycleChallengeStatus.VERIFYING:
            item.verification_lease_id = UUID(int=id(item) % (2**128))
            item.verification_lease_expires_at = item.expires_at
        return item

    pending = challenge(LifecycleChallengeStatus.PENDING)
    active = [pending, *(challenge(LifecycleChallengeStatus.VERIFYING) for _ in range(3))]
    bucket = LifecycleRateLimitBucket(
        actor_id=ACTOR_ID,
        attempt_count=2,
        window_started_at=now,
        window_expires_at=now + timedelta(minutes=15),
    )
    db = Mock()
    db.scalars.return_value.all.return_value = active
    db.scalar.return_value = pending

    with (
        patch(
            "app.systems.sandbox.lifecycle.challenge_store._challenge_for_token",
            return_value=pending,
        ),
        patch(
            "app.systems.sandbox.lifecycle.challenge_store._refresh_failure_bucket",
            return_value=bucket,
        ),
        patch("app.systems.sandbox.lifecycle.challenge_store._blocked_until", return_value=None),
        pytest.raises(LifecycleActorBlocked),
    ):
        begin_verification(
            db,
            CHALLENGE_TOKEN,
            ACTOR_ID,
            LifecycleOperation.CLOSE,
            "department",
            target_id,
            now=now,
        )

    db.rollback.assert_called_once()


def test_provider_password_grant_returns_only_the_explicitly_bound_local_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock()
    provider_id = UUID("00000000-0000-0000-0000-000000000124")
    local = SimpleNamespace(
        id=ACTOR_ID,
        supabase_user_id=provider_id,
        email="actor@example.com",
        is_deleted=False,
        expires_at=None,
        status="active",
        invitation_sent_at=None,
        role="admin",
    )
    db.scalar.return_value = local
    client = Mock()
    client.password_grant.return_value = ProviderTokens("access", "refresh", provider_id, 600)
    client.get_user.return_value = ProviderUser(provider_id, None, local.email)

    returned_id = ProviderPasswordGrantClient(
        db, client=client, enforce_rate_limit=False
    ).verify_password("actor@example.com", CONFIRMATION_PASSWORD)

    assert returned_id == ACTOR_ID
    client.sign_out.assert_called_once_with("access", scope="local")


def test_provider_password_grant_rejects_an_unbound_provider_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock()
    db.scalar.return_value = None
    client = Mock()
    client.password_grant.return_value = ProviderTokens("access", "refresh", ACTOR_ID, 600)
    client.get_user.return_value = ProviderUser(ACTOR_ID, None, "actor@example.com")

    with pytest.raises(LifecycleInvalidCredentials):
        ProviderPasswordGrantClient(db, client=client, enforce_rate_limit=False).verify_password(
            "actor@example.com", CONFIRMATION_PASSWORD
        )


def test_provider_password_outage_is_an_explicit_step_up_failure() -> None:
    client = Mock()
    client.password_grant.side_effect = SupabaseAuthUnavailable("offline")
    with pytest.raises(LifecyclePasswordServiceUnavailable):
        ProviderPasswordGrantClient(
            Mock(), client=client, enforce_rate_limit=False
        ).verify_password("actor@example.com", CONFIRMATION_PASSWORD)


def test_provider_password_step_up_preserves_backend_attempt_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    blocked = SimpleNamespace(blocked_until=datetime.now(UTC) + timedelta(minutes=1))
    budget = SimpleNamespace(
        cleanup_expired_buckets=lambda *_a, **_kw: None,
        login_fingerprint=lambda *_a: "fingerprint",
        lock_bucket=lambda *_a: blocked,
        login_retry_after=lambda *_a: 60,
    )
    monkeypatch.setattr(password_module, "rate_limits", budget, raising=False)
    client = Mock()

    with pytest.raises(LifecyclePasswordRateLimited):
        ProviderPasswordGrantClient(Mock(), client=client).verify_password(
            "actor@example.com", CONFIRMATION_PASSWORD
        )

    client.password_grant.assert_not_called()
