"""Transactional event enqueueing for published Sandbox triggers."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerEvent,
    TriggerEventState,
)
from app.systems.sandbox.records.models import Record


def enqueue_record_event(
    db: Session, record: Record, *, previous: dict[str, object] | None
) -> None:
    """Attach an event to the caller's record transaction only when data changed."""

    current = dict(record.data)
    if previous is None:
        kind = "record-created"
        changed = sorted(current)
        before: dict[str, object] = {}
    else:
        changed = sorted(
            key for key in set(previous) | set(current) if previous.get(key) != current.get(key)
        )
        if not changed:
            return
        kind = "field-changed"
        before = dict(previous)
    db.add(
        RecordTriggerEvent(
            org_id=record.org_id,
            record_id=record.id,
            module_id=record.module_id,
            event_kind=kind,
            changed_field_ids=changed,
            values=current,
            previous_values=before,
            depth=0,
            action_budget=100,
            state=TriggerEventState.PENDING,
            next_attempt_at=utc_now(),
        )
    )


def enqueue_child_field_event(
    db: Session,
    *,
    record: Record,
    previous: dict[str, object],
    parent: RecordTriggerEvent,
    action_budget: int,
) -> bool:
    """Queue one next-depth change event when a trigger actually changed a record."""

    current = dict(record.data)
    changed = sorted(
        key for key in set(previous) | set(current) if previous.get(key) != current.get(key)
    )
    if not changed or parent.depth >= 10 or action_budget <= 0:
        return False
    db.add(
        RecordTriggerEvent(
            org_id=record.org_id,
            record_id=record.id,
            module_id=record.module_id,
            event_kind="field-changed",
            changed_field_ids=changed,
            values=current,
            previous_values=dict(previous),
            root_event_id=parent.root_event_id or parent.id,
            depth=parent.depth + 1,
            action_budget=action_budget,
            state=TriggerEventState.PENDING,
            next_attempt_at=utc_now(),
        )
    )
    return True


def enqueue_due_schedules(db: Session, *, now: datetime | None = None) -> int:
    """Queue each due published schedule once per definition/local minute."""

    instant = now or utc_now()
    queued = 0
    definitions = db.scalars(
        select(RecordTrigger).where(
            RecordTrigger.enabled.is_(True),
            RecordTrigger.is_deleted.is_(False),
            RecordTrigger.suspended_at.is_(None),
            RecordTrigger.event_kind == "schedule",
        )
    ).all()
    for definition in definitions:
        local = instant.astimezone(ZoneInfo(definition.workspace_timezone))
        if definition.schedule_time != local.strftime("%H:%M"):
            continue
        if (
            definition.schedule_frequency == "weekly"
            and definition.schedule_weekday != local.isoweekday()
        ):
            continue
        key = f"{definition.id}:{local:%Y-%m-%dT%H:%M}"
        upper_record_id = db.scalar(
            select(Record.id)
            .where(Record.module_id == definition.module_id, Record.is_deleted.is_(False))
            .order_by(Record.id.desc())
            .limit(1)
        )
        event = RecordTriggerEvent(
            org_id=definition.org_id,
            module_id=definition.module_id,
            scheduled_trigger_id=definition.id,
            event_kind="schedule",
            changed_field_ids=[],
            values={},
            previous_values={},
            depth=0,
            action_budget=100,
            schedule_upper_record_id=upper_record_id,
            schedule_key=key,
            state=TriggerEventState.PENDING,
            next_attempt_at=instant,
        )
        db.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=None,
            request_id=uuid7(),
            request_method="TRIGGER",
            request_path=f"/internal/sandbox/triggers/{definition.id}/schedule",
        )
        nested = db.begin_nested()
        db.add(event)
        try:
            db.flush()
        except IntegrityError:
            nested.rollback()
            continue
        nested.commit()
        queued += 1
    return queued
