"""Transactional lifecycle close, reopen, and purge operations."""

import hashlib
import secrets
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from app.systems.access.users.membership import bound_organization
from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleActorBlocked,
    LifecycleChallengeBindingMismatch,
    LifecycleChallengeExhausted,
    LifecycleChallengeExpired,
    LifecycleChallengeNotFound,
    LifecycleError,
    LifecycleUnavailable,
    LifecycleUnsupportedOperation,
    LifecycleVerificationInProgress,
)
from app.systems.sandbox.lifecycle.models import (
    LifecycleChallengeStatus,
    LifecycleConfirmationChallenge,
    LifecycleRateLimitBucket,
    LifecycleRateLimitFailure,
)
from app.systems.sandbox.lifecycle.models import LifecycleOperation as ConfirmationOperation

_CHALLENGE_TTL = timedelta(minutes=5)
_FAILURE_WINDOW = timedelta(minutes=15)
_ACTOR_BLOCK_DURATION = timedelta(minutes=15)
# Keep challenge rows bounded for actors that repeatedly open the preview.
# Verifications in progress count toward this cap and are never silently
# displaced while their remote password check is still running.
_MAX_ACTIVE_CHALLENGES_PER_ACTOR = 3
_ACTIVE_CHALLENGE_STATUSES = (
    LifecycleChallengeStatus.PENDING,
    LifecycleChallengeStatus.VERIFYING,
)
_TERMINAL_CHALLENGE_STATUSES = (
    LifecycleChallengeStatus.CONSUMED,
    LifecycleChallengeStatus.EXPIRED,
    LifecycleChallengeStatus.INVALIDATED,
    LifecycleChallengeStatus.EXHAUSTED,
)


@dataclass(frozen=True)
class IssuedLifecycleChallenge:
    """The only place where the one-time plaintext token is returned."""

    challenge: LifecycleConfirmationChallenge
    token: str

    @property
    def challenge_id(self) -> UUID:
        return self.challenge.id

    @property
    def expires_at(self) -> datetime:
        return self.challenge.expires_at

    def __iter__(self) -> Iterator[object]:
        # Permit the conventional ``challenge, token = issue_challenge(...)``
        # without making the token a field on the persistence model.
        yield self.challenge
        yield self.token


@dataclass(frozen=True)
class LifecycleVerificationLease:
    challenge_id: UUID
    lease_id: UUID
    actor_id: UUID
    operation: ConfirmationOperation
    target_type: str
    target_id: UUID
    impact_digest: str
    expires_at: datetime


def _now(value: datetime | None) -> datetime:
    return value or datetime.now(UTC)


def hash_challenge_token(token: str) -> str:
    """Return the only representation of a challenge token persisted by us."""

    return hashlib.sha256(token.encode("utf-8", errors="strict")).hexdigest()


def _challenge_for_token(db: Session, token: str) -> LifecycleConfirmationChallenge:
    challenge = db.scalar(
        select(LifecycleConfirmationChallenge).where(
            LifecycleConfirmationChallenge.token_hash == hash_challenge_token(token)
        )
    )
    if challenge is None:
        raise LifecycleChallengeNotFound("Lifecycle confirmation challenge not found")
    return challenge


def _expire(challenge: LifecycleConfirmationChallenge, timestamp: datetime) -> bool:
    if (
        challenge.status
        in {
            LifecycleChallengeStatus.PENDING,
            LifecycleChallengeStatus.VERIFYING,
        }
        and timestamp >= challenge.expires_at
    ):
        challenge.status = LifecycleChallengeStatus.EXPIRED
        challenge.verification_lease_id = None
        challenge.verification_lease_expires_at = None
        return True
    return False


def _blocked_until(db: Session, actor_id: UUID, timestamp: datetime) -> datetime | None:
    bucket = db.scalar(
        select(LifecycleRateLimitBucket).where(LifecycleRateLimitBucket.actor_id == actor_id)
    )
    if bucket is not None and bucket.blocked_until is not None:
        if bucket.blocked_until > timestamp:
            return bucket.blocked_until
    return None


def issue_challenge(
    db: Session,
    actor_id: UUID,
    operation: ConfirmationOperation | str,
    target_type: str,
    target_id: UUID,
    impact_digest: str,
    *,
    now: datetime | None = None,
) -> IssuedLifecycleChallenge:
    """Create a bounded five-minute challenge and return its opaque token once."""

    try:
        resolved_operation = ConfirmationOperation(operation)
    except ValueError as error:
        raise LifecycleUnsupportedOperation(
            "Lifecycle confirmation only supports close and purge"
        ) from error
    timestamp = _now(now)
    bucket = _refresh_failure_bucket(db, actor_id, timestamp)
    if bucket.blocked_until is not None and bucket.blocked_until > timestamp:
        db.rollback()
        raise LifecycleActorBlocked("Password verification is temporarily blocked")
    try:
        _cleanup_challenge_storage(db, actor_id, timestamp)
    except LifecycleError:
        db.rollback()
        raise
    # Cleanup can remove old failure events, so refresh the rolling count before
    # committing the new challenge and bucket state.
    _refresh_failure_bucket(db, actor_id, timestamp)
    token = secrets.token_urlsafe(32)
    challenge = LifecycleConfirmationChallenge(
        org_id=bucket.org_id,
        actor_id=actor_id,
        operation=resolved_operation,
        target_type=target_type,
        target_id=target_id,
        impact_digest=impact_digest,
        token_hash=hash_challenge_token(token),
        status=LifecycleChallengeStatus.PENDING,
        created_at=timestamp,
        updated_at=timestamp,
        expires_at=timestamp + _CHALLENGE_TTL,
    )
    db.add(challenge)
    db.commit()
    return IssuedLifecycleChallenge(challenge=challenge, token=token)


def _lock_actor(db: Session, actor_id: UUID) -> None:
    """Acquire the actor lock used by every rate-limit mutation."""

    from app.systems.access.users.models import User

    actor = db.scalar(select(User).where(User.id == actor_id).with_for_update())
    if actor is None:
        raise LifecycleUnavailable("Lifecycle actor is no longer available")


def _cleanup_challenge_storage(db: Session, actor_id: UUID, timestamp: datetime) -> None:
    """Remove stale actor-owned rows and keep active challenge state bounded."""

    terminal = list(
        db.scalars(
            select(LifecycleConfirmationChallenge)
            .where(
                LifecycleConfirmationChallenge.actor_id == actor_id,
                LifecycleConfirmationChallenge.status.in_(_TERMINAL_CHALLENGE_STATUSES),
            )
            .order_by(
                LifecycleConfirmationChallenge.created_at,
                LifecycleConfirmationChallenge.id,
            )
            .with_for_update()
        ).all()
    )
    for challenge in terminal:
        db.delete(challenge)

    active = list(
        db.scalars(
            select(LifecycleConfirmationChallenge)
            .where(
                LifecycleConfirmationChallenge.actor_id == actor_id,
                LifecycleConfirmationChallenge.status.in_(_ACTIVE_CHALLENGE_STATUSES),
            )
            .order_by(
                LifecycleConfirmationChallenge.created_at,
                LifecycleConfirmationChallenge.id,
            )
            .with_for_update()
        ).all()
    )
    for challenge in active:
        if _expire(challenge, timestamp):
            db.delete(challenge)
    active = [challenge for challenge in active if challenge.status in _ACTIVE_CHALLENGE_STATUSES]
    while len(active) >= _MAX_ACTIVE_CHALLENGES_PER_ACTOR:
        pending = [
            challenge
            for challenge in active
            if challenge.status == LifecycleChallengeStatus.PENDING
        ]
        if not pending:
            raise LifecycleVerificationInProgress(
                "All active lifecycle confirmations are currently verifying"
            )
        oldest = pending[0]
        oldest.status = LifecycleChallengeStatus.INVALIDATED
        oldest.verification_lease_id = None
        oldest.verification_lease_expires_at = None
        oldest.updated_at = timestamp
        active.remove(oldest)

    old_failures = list(
        db.scalars(
            select(LifecycleRateLimitFailure)
            .where(
                LifecycleRateLimitFailure.actor_id == actor_id,
                LifecycleRateLimitFailure.occurred_at < timestamp - _FAILURE_WINDOW,
            )
            .with_for_update()
        ).all()
    )
    for failure in old_failures:
        db.delete(failure)
    db.flush()


def _validate_binding(
    challenge: LifecycleConfirmationChallenge,
    actor_id: UUID,
    operation: ConfirmationOperation | str,
    target_type: str,
    target_id: UUID,
    impact_digest: str | None,
) -> None:
    try:
        resolved_operation = ConfirmationOperation(operation)
    except ValueError:
        raise LifecycleChallengeBindingMismatch(
            "Lifecycle challenge binding does not match"
        ) from None
    if (
        challenge.actor_id != actor_id
        or challenge.operation != resolved_operation
        or challenge.target_type != target_type
        or challenge.target_id != target_id
        or (impact_digest is not None and challenge.impact_digest != impact_digest)
    ):
        raise LifecycleChallengeBindingMismatch("Lifecycle challenge binding does not match")


def begin_verification(
    db: Session,
    token: str,
    actor_id: UUID,
    operation: ConfirmationOperation | str,
    target_type: str,
    target_id: UUID,
    impact_digest: str | None = None,
    *,
    now: datetime | None = None,
) -> LifecycleVerificationLease:
    """Atomically reserve a challenge, then commit before any network call."""

    timestamp = _now(now)
    challenge = _challenge_for_token(db, token)
    # The actor row is always locked before the bucket and challenge rows.
    # record_failure follows the same order, preventing a challenge/user
    # deadlock while making this reservation linearizable per actor.
    bucket = _refresh_failure_bucket(db, actor_id, timestamp)
    active = list(
        db.scalars(
            select(LifecycleConfirmationChallenge)
            .where(
                LifecycleConfirmationChallenge.actor_id == actor_id,
                LifecycleConfirmationChallenge.status.in_(_ACTIVE_CHALLENGE_STATUSES),
            )
            .order_by(
                LifecycleConfirmationChallenge.created_at,
                LifecycleConfirmationChallenge.id,
            )
            .with_for_update()
        ).all()
    )
    for item in active:
        _expire(item, timestamp)
    # The token read above took no lock; reload the row as the lock finds it.
    locked_challenge = db.scalar(
        select(LifecycleConfirmationChallenge)
        .where(LifecycleConfirmationChallenge.id == challenge.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if locked_challenge is None:  # pragma: no cover - the row was just found
        raise LifecycleChallengeNotFound("Lifecycle confirmation challenge not found")
    challenge = locked_challenge
    _validate_binding(challenge, actor_id, operation, target_type, target_id, impact_digest)
    if _expire(challenge, timestamp) or challenge.status == LifecycleChallengeStatus.EXPIRED:
        db.commit()
        raise LifecycleChallengeExpired("Lifecycle confirmation challenge has expired")
    if challenge.status == LifecycleChallengeStatus.EXHAUSTED:
        raise LifecycleChallengeExhausted("Lifecycle confirmation challenge is exhausted")
    if challenge.status in {
        LifecycleChallengeStatus.CONSUMED,
        LifecycleChallengeStatus.INVALIDATED,
    }:
        raise LifecycleChallengeNotFound("Lifecycle confirmation challenge is no longer active")
    if challenge.status == LifecycleChallengeStatus.VERIFYING:
        if (
            challenge.verification_lease_expires_at is None
            or challenge.verification_lease_expires_at > timestamp
        ):
            raise LifecycleVerificationInProgress("Lifecycle confirmation is already verifying")
        challenge.status = LifecycleChallengeStatus.PENDING
        challenge.verification_lease_id = None
        challenge.verification_lease_expires_at = None
    verifying_count = sum(item.status == LifecycleChallengeStatus.VERIFYING for item in active)
    if (
        _blocked_until(db, actor_id, timestamp) is not None
        or bucket.attempt_count + verifying_count >= 5
    ):
        db.rollback()
        raise LifecycleActorBlocked("Password verification is temporarily blocked")

    lease_id = UUID(str(secrets.token_hex(16)))
    challenge.status = LifecycleChallengeStatus.VERIFYING
    challenge.verification_lease_id = lease_id
    # The lease lasts no longer than the challenge, preventing a second
    # verification from starting while the first remote call is in flight.
    challenge.verification_lease_expires_at = challenge.expires_at
    challenge.updated_at = timestamp
    lease = LifecycleVerificationLease(
        challenge_id=challenge.id,
        lease_id=lease_id,
        actor_id=challenge.actor_id,
        operation=ConfirmationOperation(challenge.operation),
        target_type=challenge.target_type,
        target_id=challenge.target_id,
        impact_digest=challenge.impact_digest,
        expires_at=challenge.expires_at,
    )
    db.commit()
    return lease


def _challenge_for_lease(
    db: Session,
    lease: LifecycleVerificationLease | UUID,
) -> LifecycleConfirmationChallenge:
    challenge_id = lease.challenge_id if isinstance(lease, LifecycleVerificationLease) else lease
    lease_id = lease.lease_id if isinstance(lease, LifecycleVerificationLease) else None
    challenge = db.scalar(
        select(LifecycleConfirmationChallenge)
        .where(LifecycleConfirmationChallenge.id == challenge_id)
        .with_for_update()
    )
    if challenge is None:
        raise LifecycleChallengeNotFound("Lifecycle confirmation challenge not found")
    if lease_id is not None and challenge.verification_lease_id != lease_id:
        raise LifecycleVerificationInProgress("Lifecycle verification lease is no longer valid")
    return challenge


def _refresh_failure_bucket(
    db: Session, actor_id: UUID, timestamp: datetime
) -> LifecycleRateLimitBucket:
    # Serializing on the actor row makes creation of the per-actor bucket safe
    # even when two fresh challenges fail at the same time.  This is also the
    # first lock in begin_verification's reservation order.
    _lock_actor(db, actor_id)
    bucket = db.scalar(
        select(LifecycleRateLimitBucket)
        .where(LifecycleRateLimitBucket.actor_id == actor_id)
        .with_for_update()
    )
    if bucket is None:
        bucket = LifecycleRateLimitBucket(
            org_id=bound_organization(db),
            actor_id=actor_id,
            attempt_count=0,
            window_started_at=timestamp,
            window_expires_at=timestamp + _FAILURE_WINDOW,
            updated_at=timestamp,
        )
        db.add(bucket)
        db.flush()

    cutoff = timestamp - _FAILURE_WINDOW
    events = list(
        db.scalars(
            select(LifecycleRateLimitFailure)
            .where(
                and_(
                    LifecycleRateLimitFailure.actor_id == actor_id,
                    LifecycleRateLimitFailure.occurred_at >= cutoff,
                    LifecycleRateLimitFailure.occurred_at <= timestamp,
                )
            )
            .order_by(LifecycleRateLimitFailure.occurred_at, LifecycleRateLimitFailure.id)
        ).all()
    )
    if events:
        oldest = events[0].occurred_at
        bucket.attempt_count = len(events)
        bucket.window_started_at = oldest
        bucket.window_expires_at = oldest + _FAILURE_WINDOW
    else:
        bucket.attempt_count = 0
        bucket.window_started_at = timestamp
        bucket.window_expires_at = timestamp + _FAILURE_WINDOW
    bucket.updated_at = timestamp
    if bucket.blocked_until is not None and bucket.blocked_until <= timestamp:
        bucket.blocked_until = None
    return bucket
