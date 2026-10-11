"""PostgreSQL trigger execution parity guarantees."""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.record_triggers.execution import claim_due_events
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerAction,
    RecordTriggerEvent,
)
from app.systems.sandbox.record_triggers.runner import execute_claim
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.router import create_record
from app.systems.sandbox.records.schemas import RecordCreate
from tests.sandbox_record_triggers.support import (
    document_option_id,
    field_change_trigger,
    option_id,
    publish_trigger,
)

pytestmark = pytest.mark.integration


def test_claimed_child_event_uses_its_snapshot_for_thresholds(
    integration_owner_db: Session,
) -> None:
    actor, module, fields, template = publish_trigger(integration_owner_db)
    root = _definition(
        integration_owner_db,
        template,
        "Set priority high",
        priority=-20,
        event_kind="record-created",
    )
    _set_action(
        integration_owner_db, root, fields["priority"], option_id(fields["priority"], "High")
    )
    lower = _definition(
        integration_owner_db,
        template,
        "Lower changed priority",
        priority=-10,
        event_kind="field-changed",
        trigger_field_id=fields["priority"].id,
    )
    _set_action(
        integration_owner_db, lower, fields["priority"], option_id(fields["priority"], "Low")
    )
    threshold = _definition(
        integration_owner_db,
        template,
        "Detect high priority",
        priority=10,
        event_kind="threshold-crossed",
        trigger_field_id=fields["priority"].id,
        trigger_operator="=",
        trigger_value=option_id(fields["priority"], "High"),
    )
    _set_action(
        integration_owner_db, threshold, fields["status"], option_id(fields["status"], "Complete")
    )
    record = create_record(
        RecordCreate(
            module_id=module.id,
            data={
                str(fields["request-number"].id): "REQ-SNAPSHOT",
                str(fields["priority"].id): option_id(fields["priority"], "Low"),
                str(fields["status"].id): option_id(fields["status"], "Open"),
            },
        ),
        actor,
        integration_owner_db,
    )
    integration_owner_db.commit()

    root_claim = claim_due_events(integration_owner_db)[0]
    integration_owner_db.commit()
    assert execute_claim(integration_owner_db, root_claim)
    integration_owner_db.commit()
    root_event = integration_owner_db.get(RecordTriggerEvent, root_claim.id)
    child_event = integration_owner_db.scalar(
        select(RecordTriggerEvent).where(RecordTriggerEvent.root_event_id == root_claim.id)
    )
    assert root_event is not None and root_event.action_budget == 99
    assert child_event is not None
    assert child_event.values[str(fields["priority"].id)] == option_id(fields["priority"], "High")
    assert child_event.previous_values[str(fields["priority"].id)] == option_id(
        fields["priority"], "Low"
    )

    child_claim = claim_due_events(integration_owner_db)[0]
    integration_owner_db.commit()
    assert child_claim.id == child_event.id
    assert execute_claim(integration_owner_db, child_claim)
    integration_owner_db.commit()

    record_row = integration_owner_db.get(Record, record.id)
    assert record_row is not None
    integration_owner_db.refresh(record_row)
    record = record_row
    assert record.data[str(fields["priority"].id)] == option_id(fields["priority"], "Low")
    assert record.data[str(fields["status"].id)] == option_id(fields["status"], "Complete")


def test_hundred_action_budget_prevents_an_extra_child_event(integration_owner_db: Session) -> None:
    actor, module, fields, template = publish_trigger(integration_owner_db)
    targets = [
        Field(
            module_id=module.id,
            name=f"Trigger target {index}",
            type=FieldType.TEXT,
            position=index + 10,
            config={},
        )
        for index in range(101)
    ]
    integration_owner_db.add_all(targets)
    integration_owner_db.flush()
    for index, target in enumerate(targets):
        definition = _definition(
            integration_owner_db,
            template,
            f"Spend budget {index}",
            priority=index,
            event_kind="record-created",
        )
        _set_action(integration_owner_db, definition, target, "Applied")
    record = create_record(
        RecordCreate(
            module_id=module.id,
            data={
                str(fields["request-number"].id): "REQ-BUDGET",
                str(fields["priority"].id): option_id(fields["priority"], "Low"),
                str(fields["status"].id): option_id(fields["status"], "Open"),
            },
        ),
        actor,
        integration_owner_db,
    )
    integration_owner_db.commit()

    claim = claim_due_events(integration_owner_db)[0]
    integration_owner_db.commit()
    assert execute_claim(integration_owner_db, claim)
    integration_owner_db.commit()

    event = integration_owner_db.get(RecordTriggerEvent, claim.id)
    record_row = integration_owner_db.get(Record, record.id)
    assert record_row is not None
    integration_owner_db.refresh(record_row)
    record = record_row
    assert event is not None and event.action_budget == 0
    assert len({str(target.id) for target in targets} & set(record.data)) == 100
    assert str(targets[-1].id) not in record.data
    assert (
        integration_owner_db.scalar(
            select(RecordTriggerEvent).where(RecordTriggerEvent.root_event_id == claim.id)
        )
        is None
    )


def test_equal_priority_execution_uses_the_published_designer_position(
    integration_owner_db: Session,
) -> None:
    first = field_change_trigger().model_dump(by_alias=True, mode="json")
    second = field_change_trigger().model_dump(by_alias=True, mode="json")
    for payload, trigger_id, name, value in (
        (first, "z-first", "First", "In progress"),
        (second, "a-second", "Second", "Complete"),
    ):
        payload.update(
            {
                "id": trigger_id,
                "name": name,
                "priority": 0,
                "trigger": {"kind": "record-created", "moduleId": "sample-requests"},
                "conditionGroup": {"operator": "all", "conditions": []},
            }
        )
        payload["actions"][0]["value"] = {
            "kind": "literal",
            "value": document_option_id("status", value),
        }
    actor, module, fields, _definition = publish_trigger(
        integration_owner_db,
        triggers=[
            type(field_change_trigger()).model_validate(first),
            type(field_change_trigger()).model_validate(second),
        ],
    )
    record = create_record(
        RecordCreate(
            module_id=module.id,
            data={
                str(fields["request-number"].id): "REQ-ORDER",
                str(fields["priority"].id): option_id(fields["priority"], "Low"),
                str(fields["status"].id): option_id(fields["status"], "Open"),
            },
        ),
        actor,
        integration_owner_db,
    )
    integration_owner_db.commit()

    definitions = list(
        integration_owner_db.scalars(
            select(RecordTrigger)
            .where(RecordTrigger.module_id == module.id)
            .order_by(RecordTrigger.execution_position)
        )
    )
    assert [definition.name for definition in definitions] == ["First", "Second"]
    assert [definition.execution_position for definition in definitions] == [0, 1]
    claim = claim_due_events(integration_owner_db)[0]
    integration_owner_db.commit()
    assert execute_claim(integration_owner_db, claim)
    integration_owner_db.commit()

    record_row = integration_owner_db.get(Record, record.id)
    assert record_row is not None
    integration_owner_db.refresh(record_row)
    record = record_row
    assert record.data[str(fields["status"].id)] == option_id(fields["status"], "Complete")


def test_execution_position_defaults_to_zero_and_rejects_negative_values(
    integration_owner_db: Session,
) -> None:
    _actor, _module, _fields, template = publish_trigger(integration_owner_db)
    assert template.execution_position == 0
    invalid = RecordTrigger(
        publication_id=template.publication_id,
        published_version_id=template.published_version_id,
        publisher_id=template.publisher_id,
        module_id=template.module_id,
        name="Invalid position",
        priority=0,
        execution_position=-1,
        event_kind="record-created",
        workspace_timezone=template.workspace_timezone,
        condition_operator="all",
    )
    savepoint = integration_owner_db.begin_nested()
    integration_owner_db.add(invalid)
    with pytest.raises(IntegrityError):
        integration_owner_db.flush()
    savepoint.rollback()


def _definition(
    db: Session,
    template: RecordTrigger,
    name: str,
    *,
    priority: int,
    event_kind: str,
    trigger_field_id=None,
    trigger_operator: str | None = None,
    trigger_value: str | None = None,
) -> RecordTrigger:
    definition = RecordTrigger(
        publication_id=template.publication_id,
        published_version_id=template.published_version_id,
        publisher_id=template.publisher_id,
        module_id=template.module_id,
        name=name,
        priority=priority,
        event_kind=event_kind,
        trigger_field_id=trigger_field_id,
        trigger_operator=trigger_operator,
        trigger_value_kind="literal" if trigger_value is not None else None,
        trigger_literal_value={"value": trigger_value} if trigger_value is not None else None,
        workspace_timezone=template.workspace_timezone,
        condition_operator="all",
    )
    db.add(definition)
    db.flush()
    return definition


def _set_action(db: Session, definition: RecordTrigger, field: Field, value: str) -> None:
    db.add(
        RecordTriggerAction(
            trigger_id=definition.id,
            target_field_id=field.id,
            position=0,
            kind="set-field",
            value_kind="literal",
            literal_value={"value": value},
        )
    )
