"""Durable, HMAC-keyed login and recovery request budgets."""

from datetime import UTC, datetime, timedelta
from hashlib import sha256
from hmac import digest as hmac_digest

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.common.normalization import normalize_email, normalize_username
from app.core.base_model import utc_now
from app.core.config import get_settings
from app.systems.access.identity.models import IdentityRateLimitBucket

LOGIN_WINDOW = timedelta(minutes=15)
LOGIN_COOLDOWN = timedelta(minutes=15)
STALE_BUCKET_RETENTION = LOGIN_WINDOW + LOGIN_COOLDOWN
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
    secret = get_settings().auth_jwt_secret.get_secret_value().encode("utf-8")
    content = f"{namespace}-rate-limit\x00{value}\x00{source or ''}".encode()
    return hmac_digest(secret, content, "sha256").hex()


def login_fingerprint(identifier: str, source: str | None) -> str:
    return rate_limit_fingerprint("login", identifier, source)


def lock_bucket(db: Session, fingerprint: str) -> IdentityRateLimitBucket | None:
    lock_key = int.from_bytes(sha256(fingerprint.encode("ascii")).digest()[:8], signed=True)
    db.execute(select(func.pg_advisory_xact_lock(lock_key)))
    return db.get(IdentityRateLimitBucket, fingerprint, with_for_update=True)


def cleanup_expired_buckets(db: Session, *, now_value: datetime | None = None) -> int:
    """Delete a bounded batch of buckets that cannot affect future requests."""

    cutoff = now(now_value) - STALE_BUCKET_RETENTION
    expired = db.scalars(
        select(IdentityRateLimitBucket)
        .where(IdentityRateLimitBucket.window_started_at <= cutoff)
        .order_by(IdentityRateLimitBucket.window_started_at)
        .limit(STALE_BUCKET_CLEANUP_LIMIT)
        .with_for_update()
    )
    count = 0
    for bucket in expired:
        db.delete(bucket)
        count += 1
    return count


def record_attempt(
    db: Session, fingerprint: str, bucket: IdentityRateLimitBucket | None, timestamp: datetime
) -> None:
    if bucket is None:
        db.add(
            IdentityRateLimitBucket(
                fingerprint=fingerprint, attempt_count=1, window_started_at=timestamp
            )
        )
        return
    if bucket.window_started_at + LOGIN_WINDOW <= timestamp:
        bucket.attempt_count = 1
        bucket.window_started_at = timestamp
        bucket.blocked_until = None
        return
    bucket.attempt_count += 1
    if bucket.attempt_count >= 5:
        bucket.blocked_until = timestamp + LOGIN_COOLDOWN


def recovery_request_permitted(
    db: Session, identifier: str, *, source: str | None, now_value: datetime | None = None
) -> bool:
    timestamp = now(now_value)
    cleanup_expired_buckets(db, now_value=timestamp)
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
    cleanup_expired_buckets(db, now_value=timestamp)
    fingerprint = rate_limit_fingerprint("invitation-completion-source", source or "", None)
    bucket = lock_bucket(db, fingerprint)
    if bucket is not None and bucket.blocked_until is not None and bucket.blocked_until > timestamp:
        return False
    record_attempt(db, fingerprint, bucket, timestamp)
    return True
