"""PostgreSQL guarantees for published Sandbox trigger execution."""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.record_triggers import execution as trigger_execution
from app.systems.sandbox.record_triggers.execution import (
    claim_due_events,
    mark_claim_failed,
)
from app.systems.sandbox.record_triggers.models import (
    RecordTriggerEvent,
    RecordTriggerRun,
    TriggerEventState,
)
from app.systems.sandbox.record_triggers.runner import execute_claim
from app.systems.sandbox.record_triggers.service import list_recent_runs
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.router import create_record, update_record
from app.systems.sandbox.records.schemas import RecordCreate, RecordUpdate
from tests.record_versions import record_version
from tests.sandbox_record_triggers.support import (
    event_count,
    option_id,
    publish_trigger,
)

pytestmark = pytest.mark.integration


def test_record_mutations_enqueue_once_and_execute_with_audit_and_dedupe(
    integration_owner_db: Session,
) -> None:
    actor, module, fields, definition = publish_trigger(integration_owner_db)
    record = create_record(
        RecordCreate(
            module_id=module.id,
            data={
                str(fields["request-number"].id): "REQ-001",
                str(fields["priority"].id): option_id(fields["priority"], "Low"),
                str(fields["status"].id): option_id(fields["status"], "Open"),
            },
        ),
        actor,
        integration_owner_db,
    )
    assert event_count(integration_owner_db) == 1

    update_record(
        record.id,
        RecordUpdate(data=dict(record.data)),
        actor,
        integration_owner_db,
        if_match=record_version(integration_owner_db, record.id),
    )
    assert event_count(integration_owner_db) == 1

    update_record(
        record.id,
        RecordUpdate(
            data={**record.data, str(fields["priority"].id): option_id(fields["priority"], "High")}
        ),
        actor,
        integration_owner_db,
        if_match=record_version(integration_owner_db, record.id),
    )
    assert event_count(integration_owner_db) == 2

    claims = claim_due_events(integration_owner_db)
    integration_owner_db.commit()
    assert len(claims) == 2
    claimed_events = list(
        integration_owner_db.scalars(
            select(RecordTriggerEvent).where(
                RecordTriggerEvent.id.in_([claim.id for claim in claims])
            )
        )
    )
    assert claimed_events and all(event.performed_by is None for event in claimed_events)
    for claim in claims:
        execute_claim(integration_owner_db, claim)
        integration_owner_db.commit()

    record_row = integration_owner_db.get(Record, record.id)
    assert record_row is not None
    integration_owner_db.refresh(record_row)
    record = record_row
    assert record.data[str(fields["status"].id)] == option_id(fields["status"], "In progress")
    assert (
        integration_owner_db.scalar(
            select(func.count())
            .select_from(RecordTriggerRun)
            .where(RecordTriggerRun.trigger_id == definition.id)
        )
        == 2
    )
    assert event_count(integration_owner_db) == 3
    root = integration_owner_db.scalar(
        select(RecordTriggerEvent).where(
            RecordTriggerEvent.event_kind == "field-changed",
            RecordTriggerEvent.depth == 0,
        )
    )
    assert root is not None and root.action_budget == 99
    child = integration_owner_db.scalar(
        select(RecordTriggerEvent).where(RecordTriggerEvent.depth == 1)
    )
    assert child is not None and child.root_event_id == root.id
    trigger_audit = integration_owner_db.scalar(
        select(AuditLog)
        .where(
            AuditLog.entity_id == record.id,
            AuditLog.request_method == "TRIGGER",
        )
        .order_by(AuditLog.created_at.desc())
    )
    assert trigger_audit is not None
    assert trigger_audit.performed_by is None
    assert trigger_audit.actor_label == "Trigger: Set request status"
    assert trigger_audit.request_path == f"/internal/sandbox/triggers/{definition.id}"
    assert record.performed_by is None
    recent = list_recent_runs(integration_owner_db, limit=20, offset=0)
    assert recent.total == 2
    assert recent.items[0].trigger_name == "Set request status"
    assert recent.items[0].event_kind in {"record-created", "field-changed"}
    # Pages are cut from the same newest-first order as the full list.
    pages = [list_recent_runs(integration_owner_db, limit=1, offset=index) for index in (0, 1)]
    assert [page.items[0].id for page in pages] == [item.id for item in recent.items]
    assert [page.has_more for page in pages] == [True, False]
    assert execute_claim(integration_owner_db, claims[-1]) is False


def test_event_snapshots_redact_secret_record_values(integration_owner_db: Session) -> None:
    actor, module, fields, _definition = publish_trigger(integration_owner_db)
    fields["title"].audit_redacted = True
    secret = "top-secret-trigger-value"
    record = create_record(
        RecordCreate(
            module_id=module.id,
            data={
                str(fields["request-number"].id): "REQ-SECRET",
                str(fields["title"].id): secret,
                str(fields["status"].id): option_id(fields["status"], "Open"),
            },
        ),
        actor,
        integration_owner_db,
    )
    update_record(
        record.id,
        RecordUpdate(data={**record.data, str(fields["title"].id): f"{secret}-next"}),
        actor,
        integration_owner_db,
        if_match=record_version(integration_owner_db, record.id),
    )
    integration_owner_db.commit()

    logs = integration_owner_db.scalars(
        select(AuditLog).where(
            AuditLog.entity_type == "record_trigger_events",
            AuditLog.entity_id.in_(
                select(RecordTriggerEvent.id).where(RecordTriggerEvent.record_id == record.id)
            ),
        )
    ).all()
    assert logs
    for log in logs:
        assert secret not in repr(log.before)
        assert secret not in repr(log.after)
        assert (log.after or {}).get("values") == "[REDACTED]"
        assert (log.after or {}).get("previous_values") == "[REDACTED]"


def test_failed_claim_retries_exactly_five_times(integration_owner_db: Session) -> None:
    actor, module, fields, definition = publish_trigger(integration_owner_db)
    record = Record(
        module_id=module.id,
        data={str(fields["request-number"].id): "REQ-RETRY"},
    )
    integration_owner_db.add(record)
    integration_owner_db.flush()
    event = RecordTriggerEvent(
        record_id=record.id,
        module_id=module.id,
        event_kind="record-created",
        changed_field_ids=[],
        values={},
        previous_values={},
        depth=0,
        action_budget=100,
        state=TriggerEventState.PENDING,
        next_attempt_at=utc_now(),
    )
    integration_owner_db.add(event)
    integration_owner_db.commit()

    for attempt in range(1, 6):
        event.next_attempt_at = utc_now()
        integration_owner_db.commit()
        claim = claim_due_events(integration_owner_db)[0]
        integration_owner_db.commit()
        terminal = mark_claim_failed(integration_owner_db, claim)
        integration_owner_db.commit()
        integration_owner_db.refresh(event)
        assert event.attempt_count == attempt
        assert terminal is (attempt == 5)
        assert event.state == (
            TriggerEventState.FAILED if attempt == 5 else TriggerEventState.PENDING
        )

    run = integration_owner_db.scalar(
        select(RecordTriggerRun).where(
            RecordTriggerRun.event_id == event.id,
            RecordTriggerRun.trigger_id == definition.id,
        )
    )
    assert run is not None
    assert run.state == "failed"
    assert run.details == {"reason": "execution_failed", "attempts": 5}
    assert run.performed_by == actor.id

    crashed_fifth_attempt = RecordTriggerEvent(
        record_id=record.id,
        module_id=module.id,
        event_kind="record-created",
        changed_field_ids=[],
        values=dict(record.data),
        previous_values={},
        depth=0,
        action_budget=100,
        state=TriggerEventState.RUNNING,
        attempt_count=5,
        next_attempt_at=utc_now() - timedelta(minutes=1),
        lease_token=uuid7(),
        lease_expires_at=utc_now() - timedelta(seconds=1),
    )
    integration_owner_db.add(crashed_fifth_attempt)
    integration_owner_db.commit()

    assert claim_due_events(integration_owner_db) == []
    integration_owner_db.commit()
    integration_owner_db.refresh(crashed_fifth_attempt)
    assert crashed_fifth_attempt.state == TriggerEventState.FAILED
    assert crashed_fifth_attempt.attempt_count == 5


def test_releasing_an_unprocessed_claim_does_not_spend_an_attempt(
    integration_owner_db: Session,
) -> None:
    _actor, module, fields, _definition = publish_trigger(integration_owner_db)
    record = Record(
        module_id=module.id,
        data={str(fields["request-number"].id): "REQ-SHUTDOWN"},
    )
    integration_owner_db.add(record)
    integration_owner_db.flush()
    event = RecordTriggerEvent(
        record_id=record.id,
        module_id=module.id,
        event_kind="record-created",
        changed_field_ids=[],
        values=dict(record.data),
        previous_values={},
        depth=0,
        action_budget=100,
        state=TriggerEventState.PENDING,
        next_attempt_at=utc_now(),
    )
    integration_owner_db.add(event)
    integration_owner_db.commit()

    claim = claim_due_events(integration_owner_db)[0]
    integration_owner_db.commit()
    assert trigger_execution.release_claim(integration_owner_db, claim)
    integration_owner_db.commit()
    integration_owner_db.refresh(event)

    assert event.state == TriggerEventState.PENDING
    assert event.attempt_count == 0
    assert event.lease_token is None
    assert event.lease_expires_at is None
    replacement = claim_due_events(integration_owner_db)
    integration_owner_db.commit()
    assert [item.id for item in replacement] == [event.id]
    integration_owner_db.refresh(event)
    assert event.attempt_count == 1


def test_runtime_role_can_write_and_read_execution_rows(integration_db: Session) -> None:
    _actor, module, fields, _definition = publish_trigger(integration_db)
    record = Record(
        module_id=module.id,
        data={str(fields["request-number"].id): "REQ-RUNTIME"},
    )
    integration_db.add(record)
    integration_db.flush()
    event = RecordTriggerEvent(
        record_id=record.id,
        module_id=module.id,
        event_kind="record-created",
        changed_field_ids=[],
        values={},
        previous_values={},
        depth=0,
        action_budget=100,
        state=TriggerEventState.PENDING,
        next_attempt_at=utc_now(),
    )
    integration_db.add(event)
    integration_db.commit()

    claim = claim_due_events(integration_db)[0]
    integration_db.commit()
    assert mark_claim_failed(integration_db, claim) is False
    integration_db.commit()

    assert integration_db.get(RecordTriggerEvent, event.id) is not None
