"""Publication ordering guarantees for retained triggers."""

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.sandbox.designs.schemas import TriggerDocument
from app.systems.sandbox.publications.planner import publication_plan
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerAction,
)
from tests.sandbox_publications.support import (
    binding,
    publish_revision,
    publish_structure,
    publishable_document,
)

pytestmark = pytest.mark.integration


def test_reordering_equal_priority_triggers_preserves_definitions_and_updates_order(
    integration_owner_db: Session,
) -> None:
    document = publishable_document()
    document.triggers = [_trigger("first", "Open"), _trigger("second", "Complete")]
    publisher, published = publish_structure(integration_owner_db, document)
    first_id = binding(integration_owner_db, "trigger", "first").trigger_id
    second_id = binding(integration_owner_db, "trigger", "second").trigger_id
    assert first_id is not None and second_id is not None

    reordered = published.model_copy(deep=True)
    reordered.triggers.reverse()
    preview = publication_plan(integration_owner_db, reordered)
    assert {change.sandbox_id for change in preview.changes if change.kind == "trigger"} == {
        "first",
        "second",
    }
    assert preview.counts.triggers == 2
    publish_revision(integration_owner_db, publisher, reordered, "reorder-triggers")

    first = integration_owner_db.get(RecordTrigger, first_id)
    second = integration_owner_db.get(RecordTrigger, second_id)
    assert first is not None and second is not None
    assert binding(integration_owner_db, "trigger", "first").trigger_id == first_id
    assert binding(integration_owner_db, "trigger", "second").trigger_id == second_id
    assert (first.execution_position, second.execution_position) == (1, 0)


def test_retargeting_an_trigger_to_a_new_module_replaces_its_definition(
    integration_owner_db: Session,
) -> None:
    document = publishable_document()
    document.triggers = [_trigger("retarget", "Open")]
    publisher, published = publish_structure(integration_owner_db, document)
    original_id = binding(integration_owner_db, "trigger", "retarget").trigger_id
    assert original_id is not None
    changed = published.model_copy(deep=True)
    new_module = changed.design.modules[0].model_copy(deep=True)
    new_module.id = "new-requests"
    new_module.name = "New requests"
    new_module.fields = [new_module.fields[0].model_copy(deep=True)]
    new_module.fields[0].id = "new-request-number"
    new_module.fields[0].name = "New request number"
    changed.design.modules.append(new_module)
    changed.design.layout["new-requests"] = changed.design.layout["sample-requests"].model_copy(
        deep=True
    )
    changed.triggers = [
        _trigger(
            "retarget",
            "Open",
            module_id="new-requests",
            field_id="new-request-number",
        )
    ]
    preview = publication_plan(integration_owner_db, changed)
    assert not preview.blockers, preview.blockers

    publish_revision(integration_owner_db, publisher, changed, "retarget-trigger")

    replacement_id = binding(integration_owner_db, "trigger", "retarget").trigger_id
    assert replacement_id is not None and replacement_id != original_id
    original = integration_owner_db.get(RecordTrigger, original_id)
    replacement = integration_owner_db.get(RecordTrigger, replacement_id)
    target = binding(integration_owner_db, "field", "new-requests:new-request-number").field_id
    assert original is not None and original.is_deleted is True
    assert replacement is not None
    new_module_id = binding(integration_owner_db, "module", "new-requests").module_id
    assert replacement.module_id == new_module_id
    action = integration_owner_db.scalar(
        select(RecordTriggerAction).where(
            RecordTriggerAction.trigger_id == replacement.id,
            RecordTriggerAction.is_deleted.is_(False),
        )
    )
    assert action is not None and action.target_field_id == target


def test_reordering_condition_and_action_children_is_a_semantic_change(
    integration_owner_db: Session,
) -> None:
    document = publishable_document()
    document.triggers = [
        _trigger_with_ordered_children("first"),
        _trigger_with_ordered_children("second"),
    ]
    _publisher, published = publish_structure(integration_owner_db, document)
    changed = published.model_copy(deep=True)
    changed.triggers[0].condition_group.conditions.reverse()
    changed.triggers[0].actions.reverse()

    plan = publication_plan(integration_owner_db, changed)

    assert not plan.blockers
    assert {
        change.sandbox_id
        for change in plan.changes
        if change.kind == "trigger" and change.action == "update"
    } == {"first"}


def _trigger(
    identifier: str,
    value: str,
    *,
    module_id: str = "sample-requests",
    field_id: str = "sample-field-requests-status",
) -> TriggerDocument:
    return TriggerDocument.model_validate(
        {
            "id": identifier,
            "name": identifier.title(),
            "enabled": True,
            "priority": 0,
            "trigger": {"kind": "record-created", "moduleId": module_id},
            "conditionGroup": {"operator": "all", "conditions": []},
            "actions": [
                {
                    "id": f"{identifier}-set-status",
                    "kind": "set-field",
                    "target": {
                        "moduleId": module_id,
                        "fieldId": field_id,
                    },
                    "value": {"kind": "literal", "value": value},
                }
            ],
        }
    )


def _trigger_with_ordered_children(identifier: str) -> TriggerDocument:
    payload = _trigger(identifier, "Open").model_dump(by_alias=True, mode="json")
    payload["conditionGroup"] = {
        "operator": "all",
        "conditions": [
            {
                "id": f"{identifier}-condition-one",
                "field": {
                    "moduleId": "sample-requests",
                    "fieldId": "sample-field-requests-status",
                },
                "operator": "=",
                "value": {"kind": "literal", "value": "Open"},
            },
            {
                "id": f"{identifier}-condition-two",
                "field": {
                    "moduleId": "sample-requests",
                    "fieldId": "sample-field-requests-title",
                },
                "operator": "=",
                "value": {"kind": "literal", "value": "Ready"},
            },
        ],
    }
    payload["actions"] = [
        {
            "id": f"{identifier}-action-one",
            "kind": "set-field",
            "target": {
                "moduleId": "sample-requests",
                "fieldId": "sample-field-requests-status",
            },
            "value": {"kind": "literal", "value": "In progress"},
        },
        {
            "id": f"{identifier}-action-two",
            "kind": "set-field",
            "target": {
                "moduleId": "sample-requests",
                "fieldId": "sample-field-requests-title",
            },
            "value": {"kind": "literal", "value": "Updated title"},
        },
    ]
    return TriggerDocument.model_validate(payload)
