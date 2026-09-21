from hashlib import sha256

import pytest
from uuid6 import uuid7

from app.systems.sandbox.automations.models import (
    PublishedAutomationAction,
    PublishedAutomationCondition,
    PublishedAutomationDefinition,
)
from app.systems.sandbox.designs.schemas import AutomationDocument, DesignField
from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.fields.validation import field_config
from app.systems.sandbox.publications.automation_comparison import (
    desired_automation_signature,
    published_automation_signature,
)
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.preflight import (
    module_schema_blockers,
    structure_name_blockers,
)
from app.systems.sandbox.publications.rules import (
    _automation_blockers,
    _field_key,
    operational_config,
    relationship_metadata,
)
from tests.sandbox_designs.fixtures import sample_document
from tests.sandbox_test_runs.fixtures import sandbox_document


def test_field_binding_key_is_module_scoped() -> None:
    assert _field_key("orders", "status") != _field_key("invoices", "status")
    assert _field_key("orders:current", "status") != _field_key("orders", "current:status")
    assert len(_field_key("m" * 1_000, "f" * 1_000)) <= 1_000
    digest = sha256(b"a:b\x00c").hexdigest()
    assert _field_key("a:b", "c") != _field_key("field", digest)


def test_relationship_cardinality_maps_to_live_edge_constraints() -> None:
    class Relationship:
        cardinality = "one-to-many"

    assert relationship_metadata(Relationship()) == (True, False)


@pytest.mark.parametrize(
    ("field_type", "config", "expected"),
    [
        (
            "Text",
            {"kind": "text", "defaultValue": "new", "maxLength": 90},
            {"defaultValue": "new", "maxLength": 90},
        ),
        (
            "Number",
            {"kind": "number", "defaultValue": 3, "min": 1, "max": 9, "step": 2},
            {"defaultValue": 3, "minimum": 1, "maximum": 9, "step": 2},
        ),
        (
            "Integer",
            {"kind": "integer", "defaultValue": 4.0, "min": 0.0, "max": 10.0, "step": 2.0},
            {"defaultValue": 4, "minimum": 0, "maximum": 10, "step": 2},
        ),
        ("Checkbox", {"kind": "checkbox", "defaultValue": False}, {"defaultValue": False}),
        (
            "Select",
            {"kind": "select", "defaultValue": "Open", "options": ["Open"]},
            {"defaultValue": "Open", "options": ["Open"]},
        ),
    ],
)
def test_operational_config_uses_live_validation_keys(field_type, config, expected) -> None:
    field = DesignField.model_validate(
        {
            **sample_document().design.modules[0].fields[0].model_dump(by_alias=True),
            "type": field_type,
            "config": config,
        }
    )

    converted = operational_config(field)
    assert converted == expected
    assert (
        field_config(
            FieldType(
                {
                    "Text": "text",
                    "Number": "number",
                    "Integer": "int",
                    "Checkbox": "boolean",
                    "Select": "select",
                }[field_type]
            ),
            converted,
        )
        == converted
    )


def test_text_default_is_not_mistaken_for_a_numeric_length() -> None:
    assert field_config(FieldType.TEXT, {"defaultValue": "draft", "maxLength": 20}) == {
        "defaultValue": "draft",
        "maxLength": 20,
    }


def test_automation_semantic_signature_detects_trigger_condition_and_action_edits() -> None:
    desired = sandbox_document().automations[0]
    module_id = uuid7()
    priority_id = uuid7()
    status_id = uuid7()
    score_id = uuid7()
    module_bindings = {
        "requests": SandboxBinding(kind="module", sandbox_id="requests", module_id=module_id)
    }
    field_bindings = {
        _field_key("requests", "priority"): SandboxBinding(
            kind="field",
            sandbox_id=_field_key("requests", "priority"),
            field_id=priority_id,
        ),
        _field_key("requests", "status"): SandboxBinding(
            kind="field",
            sandbox_id=_field_key("requests", "status"),
            field_id=status_id,
        ),
        _field_key("requests", "score"): SandboxBinding(
            kind="field",
            sandbox_id=_field_key("requests", "score"),
            field_id=score_id,
        ),
    }
    live = PublishedAutomationDefinition(
        module_id=module_id,
        name=desired.name,
        enabled=True,
        priority=10,
        trigger_kind="record-created",
        condition_operator="all",
    )
    conditions = [
        PublishedAutomationCondition(
            field_id=priority_id,
            position=0,
            operator="=",
            value_kind="literal",
            literal_value={"value": "High"},
        )
    ]
    actions = [
        PublishedAutomationAction(
            target_field_id=status_id,
            position=0,
            kind="set-field",
            value_kind="literal",
            literal_value={"value": "Triaged"},
        )
    ]

    live_signature = published_automation_signature(live, conditions, actions)
    assert desired_automation_signature(desired, module_bindings, field_bindings) == live_signature

    variants: list[AutomationDocument] = []
    trigger_changed = desired.model_dump(by_alias=True, mode="json")
    trigger_changed["trigger"] = {
        "kind": "field-changed",
        "moduleId": "requests",
        "fieldId": "priority",
    }
    variants.append(AutomationDocument.model_validate(trigger_changed))
    condition_changed = desired.model_dump(by_alias=True, mode="json")
    condition_changed["conditionGroup"]["conditions"][0]["value"]["value"] = "Low"
    variants.append(AutomationDocument.model_validate(condition_changed))
    action_changed = desired.model_dump(by_alias=True, mode="json")
    action_changed["actions"][0]["value"]["value"] = "Done"
    variants.append(AutomationDocument.model_validate(action_changed))

    assert all(
        desired_automation_signature(variant, module_bindings, field_bindings) != live_signature
        for variant in variants
    )


def test_relationship_scoped_automation_references_block_publication() -> None:
    document = sandbox_document()
    base = document.automations[0].model_dump(by_alias=True, mode="json")
    variants: list[AutomationDocument] = []

    condition_field = AutomationDocument.model_validate(base)
    condition_field.condition_group.conditions[0].field.relationship_id = "request-equipment"
    variants.append(condition_field)

    condition_value_payload = AutomationDocument.model_validate(base).model_dump(
        by_alias=True, mode="json"
    )
    condition_value_payload["conditionGroup"]["conditions"][0]["value"] = {
        "kind": "field-reference",
        "moduleId": "requests",
        "fieldId": "priority",
        "relationshipId": "request-equipment",
    }
    variants.append(AutomationDocument.model_validate(condition_value_payload))

    action_target = AutomationDocument.model_validate(base)
    action_target.actions[0].target.relationship_id = "request-equipment"
    variants.append(action_target)

    trigger_value_payload = AutomationDocument.model_validate(base).model_dump(
        by_alias=True, mode="json"
    )
    trigger_value_payload["trigger"] = {
        "kind": "threshold-crossed",
        "moduleId": "requests",
        "fieldId": "score",
        "operator": ">",
        "value": {
            "kind": "field-reference",
            "moduleId": "requests",
            "fieldId": "priority",
            "relationshipId": "request-equipment",
        },
    }
    variants.append(AutomationDocument.model_validate(trigger_value_payload))

    assert all(
        "automation_relationship_reference_unsupported"
        in {blocker.code for blocker in _automation_blockers(document, automation)}
        for automation in variants
    )


def test_invalid_select_configuration_returns_a_schema_blocker() -> None:
    document = sample_document().model_copy(deep=True)
    select_field = document.design.modules[0].fields[2]
    select_field.config.options = []

    blockers = module_schema_blockers(document)

    assert ("module_schema_invalid", "sample-requests") in {
        (blocker.code, blocker.target_id) for blocker in blockers
    }


def test_closed_structure_names_do_not_block_later_active_names() -> None:
    document = sample_document().model_copy(deep=True)
    document.design.departments[0].closed = True
    document.design.departments[1].name = "Operations"
    document.design.modules[0].closed = True
    document.design.modules[1].name = "Service requests"

    assert not structure_name_blockers(document)
