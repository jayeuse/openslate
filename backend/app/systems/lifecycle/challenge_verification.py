"""Lifecycle challenge verification and completion."""

from datetime import datetime
from uuid import UUID

from sqlalchemy.orm import Session

from app.systems.lifecycle.challenge_store import (
    _ACTOR_BLOCK_DURATION,
    LifecycleVerificationLease,
    _challenge_for_lease,
    _challenge_for_token,
    _expire,
    _now,
    _refresh_failure_bucket,
    _validate_binding,
    begin_verification,
)
from app.systems.lifecycle.exceptions import (
    LifecycleActorMismatch,
    LifecycleChallengeExpired,
    LifecycleChallengeNotFound,
    LifecycleInvalidCredentials,
)
from app.systems.lifecycle.models import (
    LifecycleChallengeStatus,
    LifecycleConfirmationChallenge,
    LifecycleRateLimitFailure,
)
from app.systems.lifecycle.models import LifecycleOperation as ConfirmationOperation
from app.systems.lifecycle.password import PasswordGrantClient, SupabasePasswordGrantClient


def record_failure(
    db: Session,
    lease: LifecycleVerificationLease | UUID,
    *,
    now: datetime | None = None,
) -> LifecycleConfirmationChallenge:
    """Record one wrong password for both the challenge and actor window."""

    timestamp = _now(now)
    challenge_id = lease.challenge_id if isinstance(lease, LifecycleVerificationLease) else lease
    challenge = db.get(LifecycleConfirmationChallenge, challenge_id)
    if challenge is None:
        raise LifecycleChallengeNotFound("Lifecycle confirmation challenge not found")
    _refresh_failure_bucket(db, challenge.actor_id, timestamp)
    challenge = _challenge_for_lease(db, lease)
    if _expire(challenge, timestamp):
        db.commit()
        raise LifecycleChallengeExpired("Lifecycle confirmation challenge has expired")
    if challenge.status != LifecycleChallengeStatus.VERIFYING:
        raise LifecycleChallengeNotFound("Lifecycle confirmation challenge is not verifying")
    challenge.failed_attempts += 1
    if challenge.failed_attempts >= 5:
        challenge.status = LifecycleChallengeStatus.EXHAUSTED
    else:
        challenge.status = LifecycleChallengeStatus.PENDING
    challenge.verification_lease_id = None
    challenge.verification_lease_expires_at = None
    challenge.updated_at = timestamp
    db.add(LifecycleRateLimitFailure(actor_id=challenge.actor_id, occurred_at=timestamp))
    db.flush()
    bucket = _refresh_failure_bucket(db, challenge.actor_id, timestamp)
    if bucket.attempt_count >= 5:
        bucket.blocked_until = timestamp + _ACTOR_BLOCK_DURATION
    db.commit()
    return challenge


def record_success(
    db: Session,
    lease: LifecycleVerificationLease | UUID,
    *,
    now: datetime | None = None,
) -> LifecycleConfirmationChallenge:
    """Consume a verifying challenge after the remote password check succeeds."""

    timestamp = _now(now)
    challenge = _challenge_for_lease(db, lease)
    if _expire(challenge, timestamp):
        db.commit()
        raise LifecycleChallengeExpired("Lifecycle confirmation challenge has expired")
    if challenge.status != LifecycleChallengeStatus.VERIFYING:
        raise LifecycleChallengeNotFound("Lifecycle confirmation challenge is not verifying")
    challenge.status = LifecycleChallengeStatus.CONSUMED
    challenge.consumed_at = timestamp
    challenge.verification_lease_id = None
    challenge.verification_lease_expires_at = None
    challenge.updated_at = timestamp
    db.commit()
    return challenge


def consume_challenge(
    db: Session,
    lease: LifecycleVerificationLease | UUID,
    *,
    now: datetime | None = None,
) -> LifecycleConfirmationChallenge:
    return record_success(db, lease, now=now)


def invalidate_challenge(
    db: Session,
    challenge_id: UUID,
    *,
    now: datetime | None = None,
) -> LifecycleConfirmationChallenge:
    challenge = db.get(LifecycleConfirmationChallenge, challenge_id, with_for_update=True)
    if challenge is None:
        raise LifecycleChallengeNotFound("Lifecycle confirmation challenge not found")
    _expire(challenge, _now(now))
    if challenge.status not in {
        LifecycleChallengeStatus.CONSUMED,
        LifecycleChallengeStatus.EXPIRED,
    }:
        challenge.status = LifecycleChallengeStatus.INVALIDATED
        challenge.verification_lease_id = None
        challenge.verification_lease_expires_at = None
        challenge.updated_at = _now(now)
        db.commit()
    return challenge


def expire_challenge(
    db: Session, challenge_id: UUID, *, now: datetime | None = None
) -> LifecycleConfirmationChallenge:
    challenge = db.get(LifecycleConfirmationChallenge, challenge_id, with_for_update=True)
    if challenge is None:
        raise LifecycleChallengeNotFound("Lifecycle confirmation challenge not found")
    if _expire(challenge, _now(now)):
        challenge.updated_at = _now(now)
        db.commit()
    return challenge


def _release_verification(db: Session, lease: LifecycleVerificationLease, *, now: datetime) -> None:
    try:
        challenge = _challenge_for_lease(db, lease)
        if _expire(challenge, now):
            db.commit()
            return
        if challenge.status == LifecycleChallengeStatus.VERIFYING:
            challenge.status = LifecycleChallengeStatus.PENDING
            challenge.verification_lease_id = None
            challenge.verification_lease_expires_at = None
            challenge.updated_at = now
        db.commit()
    except LifecycleChallengeNotFound:
        db.rollback()


def verify_challenge(
    db: Session,
    token: str,
    actor_id: UUID,
    operation: ConfirmationOperation | str,
    target_type: str,
    target_id: UUID,
    impact_digest: str,
    actor_email: str,
    password: str,
    *,
    password_client: PasswordGrantClient | None = None,
    now: datetime | None = None,
) -> LifecycleConfirmationChallenge:
    """Verify a password without keeping the database transaction open."""

    lease = begin_verification(
        db,
        token,
        actor_id,
        operation,
        target_type,
        target_id,
        impact_digest,
        now=now,
    )
    try:
        client = password_client or SupabasePasswordGrantClient()
        returned_actor_id = client.verify_password(actor_email, password)
    except LifecycleInvalidCredentials:
        record_failure(db, lease, now=_now(now))
        raise
    except Exception:
        _release_verification(db, lease, now=_now(now))
        raise

    try:
        if isinstance(returned_actor_id, UUID):
            verified_actor_id = returned_actor_id
        else:  # Injectable test doubles may return a small identity object.
            verified_actor_id = UUID(str(getattr(returned_actor_id, "id", returned_actor_id)))
    except (TypeError, ValueError):
        _release_verification(db, lease, now=_now(now))
        raise LifecycleActorMismatch("Supabase returned an invalid actor identity") from None
    if verified_actor_id != actor_id:
        invalidate_challenge(db, lease.challenge_id, now=_now(now))
        raise LifecycleActorMismatch("Supabase identity does not match the authenticated actor")

    return record_success(db, lease, now=_now(now))


def challenge_impact_digest(
    db: Session,
    token: str,
    actor_id: UUID,
    operation: ConfirmationOperation | str,
    target_type: str,
    target_id: UUID,
) -> str:
    """Read a challenge's server-held digest without accepting it from a client."""

    challenge = _challenge_for_token(db, token)
    _validate_binding(challenge, actor_id, operation, target_type, target_id, None)
    return challenge.impact_digest


__all__ = [
    "begin_verification",
    "challenge_impact_digest",
    "consume_challenge",
    "expire_challenge",
    "invalidate_challenge",
    "record_failure",
    "record_success",
    "verify_challenge",
]
