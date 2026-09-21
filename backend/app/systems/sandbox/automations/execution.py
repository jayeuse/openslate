"""Lease claims and terminal retry handling for published automation events."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.sandbox.automations.models import (
    AutomationEventState,
    PublishedAutomationDefinition,
    PublishedAutomationEvent,
    PublishedAutomationRun,
)

MAX_ATTEMPTS = 5
MAX_CLAIM_BATCH = 20
LEASE_SECONDS = 120


@dataclass(frozen=True, slots=True)
class ClaimedAutomationEvent:
    id: UUID
    lease_token: UUID


def claim_due_events(db: Session, *, limit: int = MAX_CLAIM_BATCH) -> list[ClaimedAutomationEvent]:
    """Claim a bounded batch without waiting on another worker's row locks."""

    if not 1 <= limit <= MAX_CLAIM_BATCH:
        raise ValueError("Automation claim limit is out of range")
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        request_id=uuid7(), request_method="AUTOMATION", request_path="/internal/sandbox/claims"
    )
    now = utc_now()
    rows = list(
        db.scalars(
            select(PublishedAutomationEvent)
            .where(
                PublishedAutomationEvent.is_deleted.is_(False),
                or_(
                    and_(
                        PublishedAutomationEvent.state == AutomationEventState.PENDING,
                        PublishedAutomationEvent.next_attempt_at <= now,
                    ),
                    and_(
                        PublishedAutomationEvent.state == AutomationEventState.RUNNING,
                        PublishedAutomationEvent.lease_expires_at <= now,
                    ),
                ),
            )
            .order_by(PublishedAutomationEvent.next_attempt_at, PublishedAutomationEvent.id)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
    )
    claims: list[ClaimedAutomationEvent] = []
    for event in rows:
        if event.attempt_count >= MAX_ATTEMPTS:
            _terminalize(db, event)
            continue
        token = uuid7()
        event.state = AutomationEventState.RUNNING
        event.attempt_count += 1
        event.lease_token = token
        event.lease_expires_at = now + timedelta(seconds=LEASE_SECONDS)
        claims.append(ClaimedAutomationEvent(event.id, token))
    return claims


def locked_claim(
    db: Session, claim: ClaimedAutomationEvent, *, require_unexpired: bool = True
) -> PublishedAutomationEvent | None:
    clauses = [
        PublishedAutomationEvent.id == claim.id,
        PublishedAutomationEvent.state == AutomationEventState.RUNNING,
        PublishedAutomationEvent.lease_token == claim.lease_token,
    ]
    if require_unexpired:
        clauses.append(PublishedAutomationEvent.lease_expires_at > utc_now())
    return db.scalar(select(PublishedAutomationEvent).where(*clauses).with_for_update())


def mark_claim_failed(db: Session, claim: ClaimedAutomationEvent) -> bool:
    """Count one failed lease; exactly the fifth failure is terminal."""

    event = locked_claim(db, claim, require_unexpired=False)
    if event is None:
        return False
    if event.attempt_count >= MAX_ATTEMPTS:
        _terminalize(db, event)
        return True
    event.state = AutomationEventState.PENDING
    event.next_attempt_at = utc_now() + timedelta(seconds=2**event.attempt_count)
    event.lease_token = None
    event.lease_expires_at = None
    return False


def release_schedule_continuation(event: PublishedAutomationEvent) -> None:
    """Requeue a successful schedule chunk without spending a retry allowance."""

    event.attempt_count -= 1
    event.state = AutomationEventState.PENDING
    event.next_attempt_at = utc_now()
    event.lease_token = None
    event.lease_expires_at = None


def _terminalize(db: Session, event: PublishedAutomationEvent) -> None:
    definitions = db.scalars(
        select(PublishedAutomationDefinition)
        .where(
            PublishedAutomationDefinition.enabled.is_(True),
            PublishedAutomationDefinition.is_deleted.is_(False),
            PublishedAutomationDefinition.suspended_at.is_(None),
            PublishedAutomationDefinition.module_id == event.module_id,
        )
        .order_by(
            PublishedAutomationDefinition.priority,
            PublishedAutomationDefinition.execution_position,
            PublishedAutomationDefinition.created_at,
            PublishedAutomationDefinition.id,
        )
    ).all()
    for definition in definitions:
        if event.event_kind == "schedule" and definition.id != event.scheduled_automation_id:
            continue
        if event.event_kind != "schedule" and definition.trigger_kind == "schedule":
            continue
        existing = db.scalar(
            select(PublishedAutomationRun.id).where(
                PublishedAutomationRun.event_id == event.id,
                PublishedAutomationRun.automation_id == definition.id,
            )
        )
        if existing is not None:
            continue
        db.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=definition.publisher_id,
            request_id=uuid7(),
            request_method="AUTOMATION",
            request_path=f"/internal/sandbox/automations/{definition.id}",
        )
        db.add(
            PublishedAutomationRun(
                event_id=event.id,
                automation_id=definition.id,
                state="failed",
                details={"reason": "execution_failed", "attempts": event.attempt_count},
            )
        )
        db.flush()
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        request_id=uuid7(),
        request_method="AUTOMATION",
        request_path="/internal/sandbox/claims",
    )
    event.state = AutomationEventState.FAILED
    event.lease_token = None
    event.lease_expires_at = None
