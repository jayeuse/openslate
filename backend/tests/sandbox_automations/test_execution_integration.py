"""PostgreSQL guarantees for published Sandbox automation execution."""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.access.users.models import Role, UserStatus
from app.systems.access.users.permissions import ALL_CAPABILITIES, Capability
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.automations.execution import (
    claim_due_events,
    mark_claim_failed,
)
from app.systems.sandbox.automations.models import (
    AutomationEventState,
    PublishedAutomationEvent,
    PublishedAutomationRun,
)
from app.systems.sandbox.automations.runner import execute_claim
from app.systems.sandbox.automations.service import list_recent_runs
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.router import create_record, update_record
from app.systems.sandbox.records.schemas import RecordCreate, RecordUpdate
from tests.sandbox_automations.support import (
    event_count,
    publish_automation,
)

pytestmark = pytest.mark.integration


def test_record_mutations_enqueue_once_and_execute_with_audit_and_dedupe(
    integration_owner_db: Session,
) -> None:
    actor, module, fields, definition = publish_automation(integration_owner_db)
    record = create_record(
        RecordCreate(
            module_id=module.id,
            data={
                str(fields["request-number"].id): "REQ-001",
                str(fields["priority"].id): "Low",
                str(fields["status"].id): "Open",
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
    )
    assert event_count(integration_owner_db) == 1

    update_record(
        record.id,
        RecordUpdate(data={**record.data, str(fields["priority"].id): "High"}),
        actor,
        integration_owner_db,
    )
    assert event_count(integration_owner_db) == 2

    claims = claim_due_events(integration_owner_db)
    integration_owner_db.commit()
    assert len(claims) == 2
    claimed_events = list(
        integration_owner_db.scalars(
            select(PublishedAutomationEvent).where(
                PublishedAutomationEvent.id.in_([claim.id for claim in claims])
            )
        )
    )
    assert claimed_events and all(event.performed_by is None for event in claimed_events)
    for claim in claims:
        execute_claim(integration_owner_db, claim)
        integration_owner_db.commit()

    integration_owner_db.refresh(record)
    assert record.data[str(fields["status"].id)] == "In progress"
    assert (
        integration_owner_db.scalar(
            select(func.count())
            .select_from(PublishedAutomationRun)
            .where(PublishedAutomationRun.automation_id == definition.id)
        )
        == 2
    )
    assert event_count(integration_owner_db) == 3
    root = integration_owner_db.scalar(
        select(PublishedAutomationEvent).where(
            PublishedAutomationEvent.event_kind == "field-changed",
            PublishedAutomationEvent.depth == 0,
        )
    )
    assert root is not None and root.action_budget == 99
    child = integration_owner_db.scalar(
        select(PublishedAutomationEvent).where(PublishedAutomationEvent.depth == 1)
    )
    assert child is not None and child.root_event_id == root.id
    automation_audit = integration_owner_db.scalar(
        select(AuditLog)
        .where(
            AuditLog.entity_id == record.id,
            AuditLog.request_method == "AUTOMATION",
        )
        .order_by(AuditLog.created_at.desc())
    )
    assert automation_audit is not None
    assert automation_audit.performed_by == actor.id
    recent = list_recent_runs(integration_owner_db, limit=20, offset=0)
    assert recent.total == 2
    assert recent.items[0].automation_name == "Set request status"
    assert recent.items[0].event_kind in {"record-created", "field-changed"}
    assert execute_claim(integration_owner_db, claims[-1]) is False


def test_disabled_publisher_suspends_definition_without_changing_record(
    integration_owner_db: Session,
) -> None:
    actor, module, fields, definition = publish_automation(integration_owner_db)
    record = create_record(
        RecordCreate(
            module_id=module.id,
            data={
                str(fields["request-number"].id): "REQ-002",
                str(fields["priority"].id): "High",
                str(fields["status"].id): "Open",
            },
        ),
        actor,
        integration_owner_db,
    )
    actor.status = UserStatus.DISABLED.value
    integration_owner_db.commit()

    claim = claim_due_events(integration_owner_db)[0]
    integration_owner_db.commit()
    assert execute_claim(integration_owner_db, claim)
    integration_owner_db.commit()

    integration_owner_db.refresh(record)
    integration_owner_db.refresh(definition)
    run = integration_owner_db.scalar(
        select(PublishedAutomationRun).where(PublishedAutomationRun.automation_id == definition.id)
    )
    assert record.data[str(fields["status"].id)] == "Open"
    assert not definition.enabled
    assert definition.suspended_at is not None
    assert definition.suspension_reason == "Publisher no longer has permission to update records"
    assert run is not None and run.state == "suspended"




def test_event_snapshots_redact_secret_record_values(integration_owner_db: Session) -> None:
    actor, module, fields, _definition = publish_automation(integration_owner_db)
    fields["title"].audit_redacted = True
    secret = "top-secret-automation-value"
    record = create_record(
        RecordCreate(
            module_id=module.id,
            data={
                str(fields["request-number"].id): "REQ-SECRET",
                str(fields["title"].id): secret,
                str(fields["status"].id): "Open",
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
    )
    integration_owner_db.commit()

    logs = integration_owner_db.scalars(
        select(AuditLog).where(AuditLog.entity_type == "published_automation_events")
    ).all()
    assert logs
    for log in logs:
        assert secret not in repr(log.before)
        assert secret not in repr(log.after)
        assert (log.after or {}).get("values") == "[REDACTED]"
        assert (log.after or {}).get("previous_values") == "[REDACTED]"


def test_publisher_without_record_write_suspends_definition(
    integration_owner_db: Session,
) -> None:
    actor, module, fields, definition = publish_automation(integration_owner_db)
    record = create_record(
        RecordCreate(
            module_id=module.id,
            data={
                str(fields["request-number"].id): "REQ-003",
                str(fields["priority"].id): "High",
                str(fields["status"].id): "Open",
            },
        ),
        actor,
        integration_owner_db,
    )
    restricted = Role(
        role=f"automation-restricted-{uuid7()}",
        permissions={
            capability: True
            for capability in ALL_CAPABILITIES
            if capability != Capability.RECORDS_WRITE.value
        },
    )
    integration_owner_db.add(restricted)
    integration_owner_db.flush()
    actor.role_id = restricted.id
    integration_owner_db.commit()

    claim = claim_due_events(integration_owner_db)[0]
    integration_owner_db.commit()
    assert execute_claim(integration_owner_db, claim)
    integration_owner_db.commit()

    integration_owner_db.refresh(record)
    integration_owner_db.refresh(definition)
    assert record.data[str(fields["status"].id)] == "Open"
    assert not definition.enabled
    assert definition.suspension_reason == "Publisher no longer has permission to update records"


def test_failed_claim_retries_exactly_five_times(integration_owner_db: Session) -> None:
    actor, module, fields, definition = publish_automation(integration_owner_db)
    record = Record(
        module_id=module.id,
        data={str(fields["request-number"].id): "REQ-RETRY"},
    )
    integration_owner_db.add(record)
    integration_owner_db.flush()
    event = PublishedAutomationEvent(
        record_id=record.id,
        module_id=module.id,
        event_kind="record-created",
        changed_field_ids=[],
        values={},
        previous_values={},
        depth=0,
        action_budget=100,
        state=AutomationEventState.PENDING,
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
            AutomationEventState.FAILED if attempt == 5 else AutomationEventState.PENDING
        )

    run = integration_owner_db.scalar(
        select(PublishedAutomationRun).where(
            PublishedAutomationRun.event_id == event.id,
            PublishedAutomationRun.automation_id == definition.id,
        )
    )
    assert run is not None
    assert run.state == "failed"
    assert run.details == {"reason": "execution_failed", "attempts": 5}
    assert run.performed_by == actor.id

    crashed_fifth_attempt = PublishedAutomationEvent(
        record_id=record.id,
        module_id=module.id,
        event_kind="record-created",
        changed_field_ids=[],
        values=dict(record.data),
        previous_values={},
        depth=0,
        action_budget=100,
        state=AutomationEventState.RUNNING,
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
    assert crashed_fifth_attempt.state == AutomationEventState.FAILED
    assert crashed_fifth_attempt.attempt_count == 5


def test_runtime_role_can_write_and_read_execution_rows(integration_db: Session) -> None:
    _actor, module, fields, _definition = publish_automation(integration_db)
    record = Record(
        module_id=module.id,
        data={str(fields["request-number"].id): "REQ-RUNTIME"},
    )
    integration_db.add(record)
    integration_db.flush()
    event = PublishedAutomationEvent(
        record_id=record.id,
        module_id=module.id,
        event_kind="record-created",
        changed_field_ids=[],
        values={},
        previous_values={},
        depth=0,
        action_budget=100,
        state=AutomationEventState.PENDING,
        next_attempt_at=utc_now(),
    )
    integration_db.add(event)
    integration_db.commit()

    claim = claim_due_events(integration_db)[0]
    integration_db.commit()
    assert mark_claim_failed(integration_db, claim) is False
    integration_db.commit()

    assert integration_db.get(PublishedAutomationEvent, event.id) is not None
