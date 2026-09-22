"""PostgreSQL automation execution parity guarantees."""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.systems.sandbox.automations.execution import claim_due_events
from app.systems.sandbox.automations.models import (
    PublishedAutomationAction,
    PublishedAutomationDefinition,
    PublishedAutomationEvent,
)
from app.systems.sandbox.automations.runner import execute_claim
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.records.router import create_record
from app.systems.sandbox.records.schemas import RecordCreate
from tests.sandbox_automations.support import field_change_automation, publish_automation

pytestmark = pytest.mark.integration
def test_claimed_child_event_uses_its_snapshot_for_thresholds(
    integration_owner_db: Session,
) -> None:
    actor, module, fields, template = publish_automation(integration_owner_db)
    root = _definition(
        integration_owner_db,
        template,
        "Set priority high",
        priority=-20,
        trigger_kind="record-created",
    )
    _set_action(integration_owner_db, root, fields["priority"], "High")
    lower = _definition(
        integration_owner_db,
        template,
        "Lower changed priority",
        priority=-10,
        trigger_kind="field-changed",
        trigger_field_id=fields["priority"].id,
    )
    _set_action(integration_owner_db, lower, fields["priority"], "Low")
    threshold = _definition(
        integration_owner_db,
        template,
        "Detect high priority",
        priority=10,
        trigger_kind="threshold-crossed",
        trigger_field_id=fields["priority"].id,
        trigger_operator="=",
        trigger_value="High",
    )
    _set_action(integration_owner_db, threshold, fields["status"], "Complete")
    record = create_record(
        RecordCreate(
            module_id=module.id,
            data={
                str(fields["request-number"].id): "REQ-SNAPSHOT",
                str(fields["priority"].id): "Low",
                str(fields["status"].id): "Open",
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
    root_event = integration_owner_db.get(PublishedAutomationEvent, root_claim.id)
    child_event = integration_owner_db.scalar(
        select(PublishedAutomationEvent).where(
            PublishedAutomationEvent.root_event_id == root_claim.id
        )
    )
    assert root_event is not None and root_event.action_budget == 99
    assert child_event is not None
    assert child_event.values[str(fields["priority"].id)] == "High"
    assert child_event.previous_values[str(fields["priority"].id)] == "Low"

    child_claim = claim_due_events(integration_owner_db)[0]
    integration_owner_db.commit()
    assert child_claim.id == child_event.id
    assert execute_claim(integration_owner_db, child_claim)
    integration_owner_db.commit()

    integration_owner_db.refresh(record)
    assert record.data[str(fields["priority"].id)] == "Low"
    assert record.data[str(fields["status"].id)] == "Complete"


def test_hundred_action_budget_prevents_an_extra_child_event(integration_owner_db: Session) -> None:
    actor, module, fields, template = publish_automation(integration_owner_db)
    targets = [
        Field(
            module_id=module.id,
            name=f"Automation target {index}",
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
            trigger_kind="record-created",
        )
        _set_action(integration_owner_db, definition, target, "Applied")
    record = create_record(
        RecordCreate(
            module_id=module.id,
            data={
                str(fields["request-number"].id): "REQ-BUDGET",
                str(fields["priority"].id): "Low",
                str(fields["status"].id): "Open",
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

    event = integration_owner_db.get(PublishedAutomationEvent, claim.id)
    integration_owner_db.refresh(record)
    assert event is not None and event.action_budget == 0
    assert len({str(target.id) for target in targets} & set(record.data)) == 100
    assert str(targets[-1].id) not in record.data
    assert integration_owner_db.scalar(
        select(PublishedAutomationEvent).where(PublishedAutomationEvent.root_event_id == claim.id)
    ) is None


def test_equal_priority_execution_uses_the_published_designer_position(
    integration_owner_db: Session,
) -> None:
    first = field_change_automation().model_dump(by_alias=True, mode="json")
    second = field_change_automation().model_dump(by_alias=True, mode="json")
    for payload, automation_id, name, value in (
        (first, "z-first", "First", "In progress"),
        (second, "a-second", "Second", "Complete"),
    ):
        payload.update(
            {
                "id": automation_id,
                "name": name,
                "priority": 0,
                "trigger": {"kind": "record-created", "moduleId": "sample-requests"},
                "conditionGroup": {"operator": "all", "conditions": []},
            }
        )
        payload["actions"][0]["value"] = {"kind": "literal", "value": value}
    actor, module, fields, _definition = publish_automation(
        integration_owner_db,
        automations=[
            type(field_change_automation()).model_validate(first),
            type(field_change_automation()).model_validate(second),
        ],
    )
    record = create_record(
        RecordCreate(
            module_id=module.id,
            data={
                str(fields["request-number"].id): "REQ-ORDER",
                str(fields["priority"].id): "Low",
                str(fields["status"].id): "Open",
            },
        ),
        actor,
        integration_owner_db,
    )
    integration_owner_db.commit()

    definitions = list(
        integration_owner_db.scalars(
            select(PublishedAutomationDefinition)
            .where(PublishedAutomationDefinition.module_id == module.id)
            .order_by(PublishedAutomationDefinition.execution_position)
        )
    )
    assert [definition.name for definition in definitions] == ["First", "Second"]
    assert [definition.execution_position for definition in definitions] == [0, 1]
    claim = claim_due_events(integration_owner_db)[0]
    integration_owner_db.commit()
    assert execute_claim(integration_owner_db, claim)
    integration_owner_db.commit()

    integration_owner_db.refresh(record)
    assert record.data[str(fields["status"].id)] == "Complete"


def test_execution_position_defaults_to_zero_and_rejects_negative_values(
    integration_owner_db: Session,
) -> None:
    _actor, _module, _fields, template = publish_automation(integration_owner_db)
    assert template.execution_position == 0
    invalid = PublishedAutomationDefinition(
        publication_id=template.publication_id,
        published_version_id=template.published_version_id,
        publisher_id=template.publisher_id,
        module_id=template.module_id,
        name="Invalid position",
        priority=0,
        execution_position=-1,
        trigger_kind="record-created",
        workspace_timezone=template.workspace_timezone,
        condition_operator="all",
    )
    with pytest.raises(IntegrityError):
        with integration_owner_db.begin_nested():
            integration_owner_db.add(invalid)
            integration_owner_db.flush()


def _definition(
    db: Session,
    template: PublishedAutomationDefinition,
    name: str,
    *,
    priority: int,
    trigger_kind: str,
    trigger_field_id=None,
    trigger_operator: str | None = None,
    trigger_value: str | None = None,
) -> PublishedAutomationDefinition:
    definition = PublishedAutomationDefinition(
        publication_id=template.publication_id,
        published_version_id=template.published_version_id,
        publisher_id=template.publisher_id,
        module_id=template.module_id,
        name=name,
        priority=priority,
        trigger_kind=trigger_kind,
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


def _set_action(
    db: Session, definition: PublishedAutomationDefinition, field: Field, value: str
) -> None:
    db.add(
        PublishedAutomationAction(
            automation_id=definition.id,
            target_field_id=field.id,
            position=0,
            kind="set-field",
            value_kind="literal",
            literal_value={"value": value},
        )
    )
