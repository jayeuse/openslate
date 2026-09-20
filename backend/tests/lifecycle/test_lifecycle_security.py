from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe
from unittest.mock import Mock, patch
from uuid import UUID

import pytest

from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleActorBlocked,
    LifecycleInvalidCredentials,
    LifecyclePasswordRateLimited,
)
from app.systems.sandbox.lifecycle.models import (
    LifecycleChallengeStatus,
    LifecycleConfirmationChallenge,
    LifecycleOperation,
    LifecycleRateLimitBucket,
)
from app.systems.sandbox.lifecycle.password import LocalPasswordGrantClient
from app.systems.sandbox.lifecycle.service import begin_verification, hash_challenge_token

CHALLENGE_TOKEN = token_urlsafe(32)
CONFIRMATION_PASSWORD = token_urlsafe(32)

ACTOR_ID = UUID("00000000-0000-0000-0000-000000000123")


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


def test_local_password_grant_returns_the_authenticated_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock()
    monkeypatch.setattr(
        "app.systems.sandbox.lifecycle.password.authenticate_password",
        lambda *_args: type("User", (), {"id": ACTOR_ID})(),
    )

    returned_id = LocalPasswordGrantClient(db).verify_password(
        "actor@example.com", CONFIRMATION_PASSWORD
    )

    assert returned_id == ACTOR_ID


@pytest.mark.parametrize(
    ("exception", "expected"),
    [
        ("InvalidCredentials", LifecycleInvalidCredentials),
        ("IdentityRateLimited", LifecyclePasswordRateLimited),
    ],
)
def test_local_password_grant_maps_identity_failures(
    monkeypatch: pytest.MonkeyPatch,
    exception: str,
    expected: type[Exception],
) -> None:
    from app.systems.access.identity.service import IdentityRateLimited, InvalidCredentials

    failure = (
        InvalidCredentials("invalid")
        if exception == "InvalidCredentials"
        else IdentityRateLimited("rate")
    )
    monkeypatch.setattr(
        "app.systems.sandbox.lifecycle.password.authenticate_password",
        Mock(side_effect=failure),
    )

    with pytest.raises(expected):
        LocalPasswordGrantClient(Mock()).verify_password("actor@example.com", CONFIRMATION_PASSWORD)
