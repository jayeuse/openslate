"""Cooperative source/hour representatives, serialized through the caller's commit."""

from datetime import UTC, datetime, timedelta
from hashlib import sha256
from hmac import digest
from ipaddress import ip_address
from typing import Literal
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.config import get_settings
from app.core.database.session import AuditSession, get_engine
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import SecurityEventPersistenceError, append_security_event

FailureType = Literal["identity.sign_in_failure", "identity.ip_blocked"]


def canonical_source(source: str | None) -> str | None:
    try:
        address = ip_address(source or "")
    except ValueError:
        return None
    mapped = getattr(address, "ipv4_mapped", None)
    return str(mapped or address)


def append_representative_failure(
    db: Session,
    event_type: FailureType,
    source: str | None,
    *,
    now: datetime | None = None,
    actor_id: UUID | None = None,
    subject_id: UUID | None = None,
) -> None:
    """Take this lock last; acquire no user, session or budget lock afterward."""
    timestamp = (now or utc_now()).astimezone(UTC)
    start = timestamp.replace(minute=0, second=0, microsecond=0)
    end = start + timedelta(hours=1)
    address = canonical_source(source)
    secret = get_settings().security_event_server_key.get_secret_value().encode()
    bucket = f"{event_type}\x00{address or '<unknown>'}\x00{start.isoformat()}".encode()
    fingerprint = digest(secret, b"openslate:security-representative:v1:" + bucket, "sha256").hex()
    lock_key = int.from_bytes(sha256(fingerprint.encode()).digest()[:8], signed=True)
    db.execute(select(func.pg_advisory_xact_lock(lock_key)))
    existing = db.scalar(
        select(SecurityEvent.id)
        .where(
            SecurityEvent.event_type == event_type,
            SecurityEvent.fingerprint == fingerprint,
            SecurityEvent.occurred_at >= start,
            SecurityEvent.occurred_at < end,
        )
        .limit(1)
    )
    if existing is not None:
        return
    append_security_event(
        db,
        SecurityEventIngestRequest(
            event_type=event_type,
            outcome="failure" if event_type == "identity.sign_in_failure" else "denied",
            source="identity.source_policy"
            if event_type == "identity.ip_blocked"
            else "identity.login",
            operation_id=uuid7(),
            occurred_at=timestamp,
            actor_id=actor_id,
            subject_id=subject_id,
            fingerprint=fingerprint,
            reason="source_not_allowed"
            if event_type == "identity.ip_blocked"
            else "credentials_rejected",
            metadata={
                "ip_address": address,
                "bucket_start": start.isoformat(),
                "bucket_end": end.isoformat(),
            },
        ),
    )


def append_committed_failure(
    event_type: FailureType,
    source: str | None,
    *,
    actor_id: UUID | None = None,
    subject_id: UUID | None = None,
) -> None:
    """Caller must release its outer transaction before this independent append."""
    with AuditSession(bind=get_engine()) as db:
        try:
            append_representative_failure(
                db, event_type, source, actor_id=actor_id, subject_id=subject_id
            )
            db.commit()
        except SQLAlchemyError as error:
            db.rollback()
            raise SecurityEventPersistenceError("Unable to commit security event") from error
