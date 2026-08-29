"""Transactional lifecycle close, reopen, and purge operations."""

import hashlib
import secrets
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import Select, and_, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.audit.context import set_audit_actor
from app.systems.departments.models import Department
from app.systems.fields.models import Field
from app.systems.lifecycle.exceptions import (
    LifecycleActorBlocked,
    LifecycleActorMismatch,
    LifecycleChallengeBindingMismatch,
    LifecycleChallengeExhausted,
    LifecycleChallengeExpired,
    LifecycleChallengeNotFound,
    LifecycleError,
    LifecycleInvalidCredentials,
    LifecyclePlanDriftError,
    LifecyclePreflightError,
    LifecycleUnavailable,
    LifecycleUnsupportedOperation,
    LifecycleVerificationInProgress,
)
from app.systems.lifecycle.models import (
    LifecycleChallengeStatus,
    LifecycleConfirmationChallenge,
    LifecycleRateLimitBucket,
    LifecycleRateLimitFailure,
)
from app.systems.lifecycle.models import LifecycleOperation as ConfirmationOperation
from app.systems.lifecycle.password import PasswordGrantClient, SupabasePasswordGrantClient
from app.systems.lifecycle.planner import LifecyclePlan, plan_lifecycle
from app.systems.lifecycle.schemas import (
    LifecycleImpactResponse,
    LifecycleOperation,
    LifecycleTargetType,
)
from app.systems.modules.models import Module
from app.systems.records.models import Record
from app.systems.relationships.models import RelationshipEdge

_LOCK_MODELS: tuple[tuple[str, type[Any]], ...] = (
    ("departments", Department),
    ("modules", Module),
    ("fields", Field),
    ("records", Record),
    ("relationship_edges", RelationshipEdge),
)
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
    if challenge.status in {
        LifecycleChallengeStatus.PENDING,
        LifecycleChallengeStatus.VERIFYING,
    } and timestamp >= challenge.expires_at:
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

    from app.systems.users.models import User

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
    active = [
        challenge
        for challenge in active
        if challenge.status in _ACTIVE_CHALLENGE_STATUSES
    ]
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
    locked_challenge = db.scalar(
        select(LifecycleConfirmationChallenge)
        .where(LifecycleConfirmationChallenge.id == challenge.id)
        .with_for_update()
    )
    if locked_challenge is None:  # pragma: no cover - the row was just found
        raise LifecycleChallengeNotFound("Lifecycle confirmation challenge not found")
    challenge = locked_challenge
    _validate_binding(challenge, actor_id, operation, target_type, target_id, impact_digest)
    if _expire(challenge, timestamp):
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
    verifying_count = sum(
        item.status == LifecycleChallengeStatus.VERIFYING for item in active
    )
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
    db.commit()
    return LifecycleVerificationLease(
        challenge_id=challenge.id,
        lease_id=lease_id,
        actor_id=challenge.actor_id,
        operation=ConfirmationOperation(challenge.operation),
        target_type=challenge.target_type,
        target_id=challenge.target_id,
        impact_digest=challenge.impact_digest,
        expires_at=challenge.expires_at,
    )


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


def _release_verification(
    db: Session, lease: LifecycleVerificationLease, *, now: datetime
) -> None:
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


# Explicit aliases keep the confirmation API discoverable without exposing
# resource routes before the lifecycle resource implementation is ready.
issue_confirmation_challenge = issue_challenge
verify_lifecycle_password = verify_challenge


def _lock_collection(db: Session, model: type[Any], ids: tuple[UUID, ...]) -> None:
    if not ids:
        return
    statement: Select[Any] = (
        select(model)
        .where(model.id.in_(ids))
        .order_by(model.id)
        .with_for_update(nowait=True)
        .execution_options(populate_existing=True)
    )
    try:
        locked = list(db.scalars(statement).all())
    except OperationalError as error:
        db.rollback()
        raise LifecycleUnavailable(
            "Lifecycle operation is temporarily unavailable while locking its scope"
        ) from error
    if len(locked) != len(ids):
        raise LifecycleUnavailable("Lifecycle operation scope is no longer available")


def _lock_plan_scope(db: Session, plan: LifecyclePlan) -> None:
    """Acquire the complete scope in the single canonical lock order."""

    for key, model in _LOCK_MODELS:
        _lock_collection(db, model, plan.scope_ids.get(key, ()))


def _current_plan(db: Session, plan: LifecyclePlan) -> LifecyclePlan:
    return plan_lifecycle(
        db,
        plan.target_type,
        plan.target_id,
        plan.operation,
        plan.actor_id,
    )


def _transition_instances(db: Session, plan: LifecyclePlan) -> list[Any]:
    instances: list[Any] = []
    model_by_table = {
        "departments": Department,
        "modules": Module,
        "fields": Field,
        "records": Record,
    }
    for row in plan.rows:
        model = model_by_table[row.entity_type]
        instance = db.get(model, row.entity_id)
        if instance is None:
            raise LifecycleUnavailable("Lifecycle operation row is no longer available")
        instances.append(instance)
    return instances


def _purge_instances(db: Session, plan: LifecyclePlan) -> None:
    """Physically remove a validated plan in dependency-safe audited phases."""

    model_by_table = {
        "departments": Department,
        "modules": Module,
        "fields": Field,
        "records": Record,
    }

    for edge_id in plan.scope_ids.get("relationship_edges", ()):
        edge = db.get(RelationshipEdge, edge_id)
        if edge is None:
            raise LifecycleUnavailable("Lifecycle operation row is no longer available")
        db.delete(edge)
        db.flush()

    for key_strip in plan.key_strips:
        record = db.get(Record, key_strip.record_id)
        if record is None:
            raise LifecycleUnavailable("Lifecycle operation row is no longer available")
        if key_strip.key in record.data:
            record.data = {key: value for key, value in record.data.items() if key != key_strip.key}
            db.flush()

    for entity_type in ("records", "fields", "modules", "departments"):
        for row in plan.rows:
            if row.entity_type != entity_type:
                continue
            instance = db.get(model_by_table[entity_type], row.entity_id)
            if instance is None:
                raise LifecycleUnavailable("Lifecycle operation row is no longer available")
            db.delete(instance)
            db.flush()


def _execute(db: Session, plan: LifecyclePlan) -> LifecycleImpactResponse:
    _lock_plan_scope(db, plan)
    current = _current_plan(db, plan)
    if current.impact_digest != plan.impact_digest:
        db.rollback()
        raise LifecyclePlanDriftError(
            "Lifecycle impact changed after planning; obtain a new impact plan"
        )
    if current.blockers:
        db.rollback()
        raise LifecyclePreflightError(current.blockers)

    try:
        if plan.operation is LifecycleOperation.PURGE:
            _purge_instances(db, current)
        else:
            timestamp = utc_now()
            for instance in _transition_instances(db, current):
                if plan.operation is LifecycleOperation.CLOSE:
                    instance.is_deleted = True
                    instance.deleted_at = timestamp
                else:
                    instance.is_deleted = False
                    instance.deleted_at = None
                # Explicit assignment keeps every changed instance on one lifecycle
                # timestamp instead of relying on SQLAlchemy's per-instance onupdate.
                instance.updated_at = timestamp
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise LifecyclePreflightError(()) from error
    except OperationalError as error:
        db.rollback()
        raise LifecycleUnavailable("Lifecycle operation is temporarily unavailable") from error
    except LifecycleError:
        db.rollback()
        raise
    return current.response()


def execute_lifecycle(db: Session, plan: LifecyclePlan) -> LifecycleImpactResponse:
    """Execute an already displayed plan after locking and recomputing it."""

    if plan.actor_id is not None:
        set_audit_actor(db, plan.actor_id)
    return _execute(db, plan)


def close_lifecycle(
    db: Session,
    target_type: LifecycleTargetType | str,
    target_id: UUID,
    actor_id: UUID | None,
    *,
    plan: LifecyclePlan | None = None,
) -> LifecycleImpactResponse:
    selected = plan or plan_lifecycle(
        db, target_type, target_id, LifecycleOperation.CLOSE, actor_id
    )
    if selected.operation is not LifecycleOperation.CLOSE:
        raise LifecycleUnsupportedOperation("Close requires a close impact plan")
    return execute_lifecycle(db, selected)


def reopen_lifecycle(
    db: Session,
    target_type: LifecycleTargetType | str,
    target_id: UUID,
    actor_id: UUID | None,
    *,
    plan: LifecyclePlan | None = None,
) -> LifecycleImpactResponse:
    selected = plan or plan_lifecycle(
        db, target_type, target_id, LifecycleOperation.REOPEN, actor_id
    )
    if selected.operation is not LifecycleOperation.REOPEN:
        raise LifecycleUnsupportedOperation("Reopen requires a reopen impact plan")
    return execute_lifecycle(db, selected)


def purge_lifecycle(
    db: Session,
    target_type: LifecycleTargetType | str,
    target_id: UUID,
    actor_id: UUID | None,
    *,
    plan: LifecyclePlan | None = None,
) -> LifecycleImpactResponse:
    selected = plan or plan_lifecycle(
        db, target_type, target_id, LifecycleOperation.PURGE, actor_id
    )
    if selected.operation is not LifecycleOperation.PURGE:
        raise LifecycleUnsupportedOperation("Purge requires a purge impact plan")
    return execute_lifecycle(db, selected)


__all__ = [
    "IssuedLifecycleChallenge",
    "LifecycleVerificationLease",
    "close_lifecycle",
    "consume_challenge",
    "begin_verification",
    "challenge_impact_digest",
    "expire_challenge",
    "execute_lifecycle",
    "hash_challenge_token",
    "invalidate_challenge",
    "issue_challenge",
    "issue_confirmation_challenge",
    "record_failure",
    "record_success",
    "reopen_lifecycle",
    "purge_lifecycle",
    "verify_challenge",
    "verify_lifecycle_password",
]
