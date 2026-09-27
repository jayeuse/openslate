"""Lease claims and terminal retry handling for record trigger events."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerEvent,
    RecordTriggerRun,
    TriggerEventState,
)

MAX_ATTEMPTS = 5
MAX_CLAIM_BATCH = 20
LEASE_SECONDS = 120


@dataclass(frozen=True, slots=True)
class ClaimedTriggerEvent:
    id: UUID
    lease_token: UUID


def claim_due_events(db: Session, *, limit: int = MAX_CLAIM_BATCH) -> list[ClaimedTriggerEvent]:
    """Claim a bounded batch without waiting on another worker's row locks."""

    if not 1 <= limit <= MAX_CLAIM_BATCH:
        raise ValueError("Trigger claim limit is out of range")
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        request_id=uuid7(), request_method="TRIGGER", request_path="/internal/sandbox/claims"
    )
    now = utc_now()
    rows = list(
        db.scalars(
            select(RecordTriggerEvent)
            .where(
                RecordTriggerEvent.is_deleted.is_(False),
                or_(
                    and_(
                        RecordTriggerEvent.state == TriggerEventState.PENDING,
                        RecordTriggerEvent.next_attempt_at <= now,
                    ),
                    and_(
                        RecordTriggerEvent.state == TriggerEventState.RUNNING,
                        RecordTriggerEvent.lease_expires_at <= now,
                    ),
                ),
            )
            .order_by(RecordTriggerEvent.next_attempt_at, RecordTriggerEvent.id)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
    )
    claims: list[ClaimedTriggerEvent] = []
    for event in rows:
        if event.attempt_count >= MAX_ATTEMPTS:
            _terminalize(db, event)
            continue
        token = uuid7()
        event.state = TriggerEventState.RUNNING
        event.attempt_count += 1
        event.lease_token = token
        event.lease_expires_at = now + timedelta(seconds=LEASE_SECONDS)
        claims.append(ClaimedTriggerEvent(event.id, token))
    return claims


def locked_claim(
    db: Session, claim: ClaimedTriggerEvent, *, require_unexpired: bool = True
) -> RecordTriggerEvent | None:
    clauses = [
        RecordTriggerEvent.id == claim.id,
        RecordTriggerEvent.state == TriggerEventState.RUNNING,
        RecordTriggerEvent.lease_token == claim.lease_token,
    ]
    if require_unexpired:
        clauses.append(RecordTriggerEvent.lease_expires_at > utc_now())
    return db.scalar(select(RecordTriggerEvent).where(*clauses).with_for_update())


def mark_claim_failed(db: Session, claim: ClaimedTriggerEvent) -> bool:
    """Count one failed lease; exactly the fifth failure is terminal."""

    event = locked_claim(db, claim, require_unexpired=False)
    if event is None:
        return False
    if event.attempt_count >= MAX_ATTEMPTS:
        _terminalize(db, event)
        return True
    event.state = TriggerEventState.PENDING
    event.next_attempt_at = utc_now() + timedelta(seconds=2**event.attempt_count)
    event.lease_token = None
    event.lease_expires_at = None
    return False


def release_claim(db: Session, claim: ClaimedTriggerEvent) -> bool:
    """Return an unprocessed lease to the queue without spending an attempt."""

    event = locked_claim(db, claim, require_unexpired=False)
    if event is None:
        return False
    event.attempt_count = max(0, event.attempt_count - 1)
    event.state = TriggerEventState.PENDING
    event.next_attempt_at = utc_now()
    event.lease_token = None
    event.lease_expires_at = None
    return True


def release_schedule_continuation(event: RecordTriggerEvent) -> None:
    """Requeue a successful schedule chunk without spending a retry allowance."""

    event.attempt_count -= 1
    event.state = TriggerEventState.PENDING
    event.next_attempt_at = utc_now()
    event.lease_token = None
    event.lease_expires_at = None


def _terminalize(db: Session, event: RecordTriggerEvent) -> None:
    statement = (
        select(RecordTrigger)
        .where(
            RecordTrigger.enabled.is_(True),
            RecordTrigger.suspended_at.is_(None),
            RecordTrigger.module_id == event.module_id,
        )
        .order_by(
            RecordTrigger.priority,
            RecordTrigger.execution_position,
            RecordTrigger.created_at,
            RecordTrigger.id,
        )
    )
    if event.event_kind == "schedule":
        statement = statement.where(
            RecordTrigger.id == event.scheduled_trigger_id,
            RecordTrigger.event_kind == "schedule",
        )
    else:
        statement = statement.where(
            RecordTrigger.is_deleted.is_(False),
            RecordTrigger.event_kind != "schedule",
        )
    definitions = db.scalars(statement).all()
    for definition in definitions:
        existing = db.scalar(
            select(RecordTriggerRun.id).where(
                RecordTriggerRun.event_id == event.id,
                RecordTriggerRun.trigger_id == definition.id,
            )
        )
        if existing is not None:
            continue
        db.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=definition.publisher_id,
            request_id=uuid7(),
            request_method="TRIGGER",
            request_path=f"/internal/sandbox/triggers/{definition.id}",
        )
        db.add(
            RecordTriggerRun(
                event_id=event.id,
                trigger_id=definition.id,
                state="failed",
                details={"reason": "execution_failed", "attempts": event.attempt_count},
            )
        )
        db.flush()
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        request_id=uuid7(),
        request_method="TRIGGER",
        request_path="/internal/sandbox/claims",
    )
    event.state = TriggerEventState.FAILED
    event.lease_token = None
    event.lease_expires_at = None
