"""Durable, HMAC-keyed login and recovery request budgets."""

from datetime import UTC, datetime, timedelta
from hashlib import sha256
from hmac import digest as hmac_digest
from math import ceil
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.normalization import normalize_email, normalize_username
from app.core.base_model import utc_now
from app.core.config import get_settings
from app.core.database.session import AuditSession, get_engine
from app.systems.access.identity.models import IdentityRateLimitBucket
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.security_failures import canonical_source
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.workspace.models import PlatformSettings

LOGIN_WINDOW = timedelta(minutes=15)
LOGIN_COOLDOWN = timedelta(minutes=15)
LOGIN_ACCOUNT_FAILURE_LIMIT = 10
LOGIN_SOURCE_FAILURE_LIMIT = 30
MFA_WINDOW = timedelta(minutes=15)
MFA_COOLDOWN = timedelta(minutes=15)
MFA_ACCOUNT_FAILURE_LIMIT = 5
MFA_SOURCE_FAILURE_LIMIT = 20
STALE_BUCKET_RETENTION = timedelta(hours=48)
STALE_BUCKET_CLEANUP_LIMIT = 100


def now(value: datetime | None = None) -> datetime:
    timestamp = value or utc_now()
    return timestamp if timestamp.tzinfo is not None else timestamp.replace(tzinfo=UTC)


def normalize_identifier(value: str) -> str:
    try:
        normalized = normalize_email(value) if "@" in value else normalize_username(value)
        return normalized if isinstance(normalized, str) else value.strip().lower()
    except ValueError:
        return value.strip().lower()


def rate_limit_fingerprint(namespace: str, value: str, source: str | None) -> str:
    secret = get_settings().security_event_server_key.get_secret_value().encode("utf-8")
    content = b"openslate:identity-rate-limit:v1:" + (
        f"{namespace}-rate-limit\x00{value}\x00{source or ''}".encode()
    )
    return hmac_digest(secret, content, "sha256").hex()


def login_fingerprint(identifier: str, source: str | None) -> str:
    return rate_limit_fingerprint("login", identifier, source)


def lock_bucket(db: Session, fingerprint: str) -> IdentityRateLimitBucket | None:
    lock_key = int.from_bytes(sha256(fingerprint.encode("ascii")).digest()[:8], signed=True)
    db.execute(select(func.pg_advisory_xact_lock(lock_key)))
    return db.get(IdentityRateLimitBucket, fingerprint, with_for_update=True)


def cleanup_expired_buckets(*, now_value: datetime | None = None) -> int:
    """Commit bounded stale-bucket cleanup independently of the request transaction."""

    cutoff = now(now_value) - STALE_BUCKET_RETENTION
    with AuditSession(get_engine()) as db:
        expired = db.scalars(
            select(IdentityRateLimitBucket)
            .where(
                IdentityRateLimitBucket.window_started_at <= cutoff,
                (IdentityRateLimitBucket.blocked_until.is_(None))
                | (IdentityRateLimitBucket.blocked_until <= now(now_value)),
            )
            .order_by(IdentityRateLimitBucket.window_started_at)
            .limit(STALE_BUCKET_CLEANUP_LIMIT)
            # A bucket another transaction holds is in use, not stale: skip it. Locking it
            # in window order deadlocked with requests that lock buckets in key order.
            .with_for_update(skip_locked=True)
        )
        count = 0
        for bucket in expired:
            db.delete(bucket)
            count += 1
        db.commit()
        return count


def login_retry_after(
    db: Session,
    bucket: IdentityRateLimitBucket | None,
    timestamp: datetime,
    profile: PlatformSettings,
    *,
    source: str | None = None,
    actor_id: UUID | None = None,
    identifier: str | None = None,
    source_budget: bool = False,
) -> int | None:
    if identifier is not None:
        retry = _login_budget(identifier, timestamp, source=source, source_budget=source_budget)
        if retry is not None:
            return retry
    if bucket is None:
        return None
    if bucket.blocked_until is not None and bucket.blocked_until > timestamp:
        return max(1, ceil((bucket.blocked_until - timestamp).total_seconds()))
    if (
        bucket.window_started_at + timedelta(minutes=profile.login_window_minutes) > timestamp
        and bucket.attempt_count >= profile.login_failed_attempt_threshold
    ):
        bucket.blocked_until = timestamp + timedelta(minutes=profile.login_cooldown_minutes)
        _record_login_lockout(db, timestamp, source, actor_id)
        db.commit()
        return profile.login_cooldown_minutes * 60
    return None


def record_attempt(
    db: Session,
    fingerprint: str,
    bucket: IdentityRateLimitBucket | None,
    timestamp: datetime,
    *,
    policy: PlatformSettings | None = None,
    login: bool = False,
    source: str | None = None,
    actor_id: UUID | None = None,
    threshold: int = 5,
    window: timedelta = LOGIN_WINDOW,
    cooldown: timedelta = LOGIN_COOLDOWN,
    identifier: str | None = None,
    source_budget: bool = False,
) -> IdentityRateLimitBucket:
    if identifier is not None:
        _login_budget(
            identifier,
            timestamp,
            source=source,
            actor_id=actor_id,
            failed=True,
            source_budget=source_budget,
        )
    if policy is not None:
        window = timedelta(minutes=policy.login_window_minutes)
        cooldown = timedelta(minutes=policy.login_cooldown_minutes)
        threshold = policy.login_failed_attempt_threshold
    was_blocked = (
        bucket is not None and bucket.blocked_until is not None and bucket.blocked_until > timestamp
    )
    if bucket is None:
        bucket = IdentityRateLimitBucket(
            fingerprint=fingerprint,
            attempt_count=1,
            window_started_at=timestamp,
            blocked_until=None,
        )
        db.add(bucket)
    elif bucket.window_started_at + window <= timestamp:
        bucket.attempt_count = 1
        bucket.window_started_at = timestamp
        bucket.blocked_until = None
    else:
        bucket.attempt_count += 1
    if bucket.attempt_count >= threshold:
        bucket.blocked_until = timestamp + cooldown
        if login and not was_blocked:
            _record_login_lockout(db, timestamp, source, actor_id)
    return bucket


def _login_budget(
    identifier: str,
    timestamp: datetime,
    *,
    source: str | None,
    actor_id: UUID | None = None,
    failed: bool = False,
    source_budget: bool = False,
) -> int | None:
    limits = {
        rate_limit_fingerprint(
            "login-account", normalize_identifier(identifier), None
        ): LOGIN_ACCOUNT_FAILURE_LIMIT,
    }
    if source_budget:
        limits[rate_limit_fingerprint("login-source", source or "", None)] = (
            LOGIN_SOURCE_FAILURE_LIMIT
        )
    with AuditSession(get_engine()) as db:
        buckets = [
            (value, lock_bucket(db, value) if failed else db.get(IdentityRateLimitBucket, value))
            for value in sorted(limits)
        ]
        retry = max(
            (
                ceil((item.blocked_until - timestamp).total_seconds())
                for _, item in buckets
                if item is not None and item.blocked_until is not None
            ),
            default=0,
        )
        if failed:
            for value, item in buckets:
                if (
                    item is not None
                    and item.blocked_until is not None
                    and item.blocked_until > timestamp
                ):
                    item.attempt_count += 1
                    continue
                item = record_attempt(
                    db,
                    value,
                    item,
                    timestamp,
                    threshold=limits[value],
                    login=True,
                    source=source,
                    actor_id=actor_id,
                )
                if limits[value] == LOGIN_SOURCE_FAILURE_LIMIT and item.blocked_until is not None:
                    item.blocked_until = item.window_started_at + LOGIN_WINDOW
            db.commit()
        return retry if retry > 0 else None


def clear_login_account_budget(db: Session, identifier: str) -> None:
    bucket = lock_bucket(
        db, rate_limit_fingerprint("login-account", normalize_identifier(identifier), None)
    )
    if bucket is not None:
        db.delete(bucket)


def mfa_verification_retry_after(user_id: UUID, *, source: str | None) -> int | None:
    return _mfa_budget(user_id, source=source, failed=False)


def record_mfa_failure(user_id: UUID, *, source: str | None) -> None:
    """Commit a failed code and any cooldown transition independently of the request."""
    _mfa_budget(user_id, source=source, failed=True)


def _mfa_budget(user_id: UUID, *, source: str | None, failed: bool = False) -> int | None:
    """Check or commit a failed code independently of the request's transaction."""

    limits = {
        rate_limit_fingerprint("mfa-account", str(user_id), None): MFA_ACCOUNT_FAILURE_LIMIT,
        rate_limit_fingerprint("mfa-source", source or "", None): MFA_SOURCE_FAILURE_LIMIT,
    }
    with AuditSession(get_engine()) as db:
        buckets = [(value, lock_bucket(db, value)) for value in sorted(limits)]
        timestamp = now()
        retry_after = max(
            (
                ceil((bucket.blocked_until - timestamp).total_seconds())
                for _, bucket in buckets
                if bucket is not None and bucket.blocked_until is not None
            ),
            default=0,
        )
        started_cooldown = False
        if failed:
            for value, bucket in buckets:
                if (
                    bucket is not None
                    and bucket.blocked_until is not None
                    and bucket.blocked_until > timestamp
                ):
                    bucket.attempt_count += 1
                    continue
                bucket = record_attempt(
                    db,
                    value,
                    bucket,
                    timestamp,
                    threshold=limits[value],
                    window=MFA_WINDOW,
                    cooldown=MFA_COOLDOWN,
                )
                if limits[value] == MFA_SOURCE_FAILURE_LIMIT and bucket.blocked_until is not None:
                    bucket.blocked_until = bucket.window_started_at + MFA_WINDOW
                started_cooldown |= (
                    bucket.blocked_until is not None and bucket.blocked_until > timestamp
                )
        if started_cooldown:
            append_security_event(
                db,
                SecurityEventIngestRequest(
                    event_type="identity.lockout",
                    outcome="denied",
                    source="identity.mfa_budget",
                    operation_id=uuid7(),
                    occurred_at=timestamp,
                    actor_id=user_id,
                    subject_id=user_id,
                    reason="failed_attempt_limit",
                    metadata={"ip_address": canonical_source(source)},
                ),
            )
        if failed:
            db.commit()
        return retry_after if retry_after > 0 else None


def _record_login_lockout(
    db: Session, timestamp: datetime, source: str | None, actor_id: UUID | None
) -> None:
    append_security_event(
        db,
        SecurityEventIngestRequest(
            event_type="identity.lockout",
            outcome="denied",
            source="identity.login_budget",
            operation_id=uuid7(),
            occurred_at=timestamp,
            actor_id=actor_id,
            subject_id=actor_id,
            reason="failed_attempt_limit",
            metadata={"ip_address": canonical_source(source)},
        ),
    )


def recovery_request_permitted(
    db: Session, identifier: str, *, source: str | None, now_value: datetime | None = None
) -> bool:
    timestamp = now(now_value)
    cleanup_expired_buckets(now_value=timestamp)
    fingerprints = sorted(
        {
            rate_limit_fingerprint("recovery-recipient", normalize_identifier(identifier), None),
            rate_limit_fingerprint("recovery-source", source or "", None),
        }
    )
    buckets = [(value, lock_bucket(db, value)) for value in fingerprints]
    if any(
        item is not None and item.blocked_until is not None and item.blocked_until > timestamp
        for _, item in buckets
    ):
        return False
    for value, item in buckets:
        record_attempt(db, value, item, timestamp)
    return True


def invitation_completion_permitted(
    db: Session,
    *,
    source: str | None,
    now_value: datetime | None = None,
    enforce_rate_limit: bool = True,
) -> bool:
    """Consume an anonymous admission budget before invitation audit events."""

    if not enforce_rate_limit:
        return True
    timestamp = now(now_value)
    cleanup_expired_buckets(now_value=timestamp)
    fingerprint = rate_limit_fingerprint("invitation-completion-source", source or "", None)
    bucket = lock_bucket(db, fingerprint)
    if bucket is not None and bucket.blocked_until is not None and bucket.blocked_until > timestamp:
        return False
    record_attempt(db, fingerprint, bucket, timestamp)
    return True
