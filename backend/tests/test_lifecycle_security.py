from datetime import UTC, datetime, timedelta
from unittest.mock import Mock, patch
from uuid import UUID

import pytest
from pydantic import SecretStr

from app.core.config import Settings
from app.systems.lifecycle.exceptions import (
    LifecycleActorBlocked,
    LifecycleInvalidCredentials,
    LifecyclePasswordRateLimited,
    LifecyclePasswordServiceUnavailable,
)
from app.systems.lifecycle.models import (
    LifecycleChallengeStatus,
    LifecycleConfirmationChallenge,
    LifecycleOperation,
    LifecycleRateLimitBucket,
)
from app.systems.lifecycle.password import SupabasePasswordGrantClient
from app.systems.lifecycle.service import begin_verification, hash_challenge_token

ACTOR_ID = UUID("00000000-0000-0000-0000-000000000123")
PUBLISHABLE_KEY = "publishable-key"


def _settings() -> Settings:
    return Settings(
        database_url="postgresql://localhost/test",
        supabase_url="https://example.supabase.co",
        supabase_publishable_key=SecretStr(PUBLISHABLE_KEY),
    )


def _response(status_code: int, payload: object) -> Mock:
    response = Mock()
    response.status_code = status_code
    response.json.return_value = payload
    return response


def test_challenge_tokens_are_256_bit_and_only_the_hash_is_persistable() -> None:
    token = "opaque-token"

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
        patch("app.systems.lifecycle.service._challenge_for_token", return_value=pending),
        patch("app.systems.lifecycle.service._refresh_failure_bucket", return_value=bucket),
        patch("app.systems.lifecycle.service._blocked_until", return_value=None),
        pytest.raises(LifecycleActorBlocked),
    ):
        begin_verification(
            db,
            "opaque-token",
            ACTOR_ID,
            LifecycleOperation.CLOSE,
            "department",
            target_id,
            now=now,
        )

    db.rollback.assert_called_once()


def test_password_grant_revokes_only_the_temporary_session() -> None:
    access_token = "temporary-access-token"
    http_client = Mock()
    http_client.post.side_effect = [
        _response(
            200,
            {"access_token": access_token, "user": {"id": str(ACTOR_ID)}},
        ),
        _response(204, {}),
    ]

    returned_id = SupabasePasswordGrantClient(
        _settings(), http_client=http_client
    ).verify_password("actor@example.com", "password-that-is-not-stored")

    assert returned_id == ACTOR_ID
    assert http_client.post.call_count == 2
    grant_call = http_client.post.call_args_list[0]
    assert grant_call.args[0] == "/auth/v1/token?grant_type=password"
    assert grant_call.kwargs["json"] == {
        "email": "actor@example.com",
        "password": "password-that-is-not-stored",
    }
    revoke_call = http_client.post.call_args_list[1]
    assert revoke_call.args[0] == "/auth/v1/logout"
    assert revoke_call.kwargs["json"] is None
    assert revoke_call.kwargs["headers"]["Authorization"] == f"Bearer {access_token}"


@pytest.mark.parametrize(
    ("status", "error"),
    [
        (400, LifecycleInvalidCredentials),
        (401, LifecycleInvalidCredentials),
        (429, LifecyclePasswordRateLimited),
        (503, LifecyclePasswordServiceUnavailable),
    ],
)
def test_password_grant_maps_upstream_failures_without_retry(
    status: int, error: type[Exception]
) -> None:
    http_client = Mock()
    http_client.post.return_value = _response(status, {"error": "redacted upstream detail"})

    with pytest.raises(error) as raised:
        SupabasePasswordGrantClient(_settings(), http_client=http_client).verify_password(
            "actor@example.com", "super-secret-password"
        )

    assert http_client.post.call_count == 1
    assert "super-secret-password" not in str(raised.value)
    assert "redacted upstream detail" not in str(raised.value)
    assert PUBLISHABLE_KEY not in str(raised.value)


def test_password_grant_rejects_malformed_success_without_leaking_session_data() -> None:
    http_client = Mock()
    http_client.post.return_value = _response(
        200,
        {"access_token": "temporary-token", "user": {"id": "not-a-uuid"}},
    )
    http_client.post.side_effect = [
        _response(
            200,
            {"access_token": "temporary-token", "user": {"id": "not-a-uuid"}},
        ),
        _response(204, {}),
    ]

    with pytest.raises(LifecyclePasswordServiceUnavailable):
        SupabasePasswordGrantClient(_settings(), http_client=http_client).verify_password(
            "actor@example.com", "super-secret-password"
        )

    assert http_client.post.call_count == 2
