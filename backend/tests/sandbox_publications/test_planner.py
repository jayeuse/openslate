from hashlib import sha256
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from uuid6 import uuid7

from app.systems.sandbox.designs.schemas import DesignField, TriggerDocument
from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.fields.validation import field_config
from app.systems.sandbox.publications.close_rules import _module_has_unmanaged_fields
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.preflight import (
    module_schema_blockers,
    structure_name_blockers,
)
from app.systems.sandbox.publications.rules import (
    _field_key,
    _trigger_blockers,
    operational_config,
    relationship_metadata,
)
from app.systems.sandbox.publications.trigger_comparison import (
    desired_trigger_signature,
    record_trigger_signature,
)
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerAction,
    RecordTriggerCondition,
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


def test_trigger_semantic_signature_detects_trigger_condition_and_action_edits() -> None:
    desired = sandbox_document().triggers[0]
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
    live = RecordTrigger(
        module_id=module_id,
        name=desired.name,
        enabled=True,
        priority=10,
        event_kind="record-created",
        condition_operator="all",
    )
    conditions = [
        RecordTriggerCondition(
            field_id=priority_id,
            position=0,
            operator="=",
            value_kind="literal",
            literal_value={"value": "High"},
        )
    ]
    actions = [
        RecordTriggerAction(
            target_field_id=status_id,
            position=0,
            kind="set-field",
            value_kind="literal",
            literal_value={"value": "Triaged"},
        )
    ]

    live_signature = record_trigger_signature(live, conditions, actions)
    assert desired_trigger_signature(desired, module_bindings, field_bindings) == live_signature

    variants: list[TriggerDocument] = []
    trigger_changed = desired.model_dump(by_alias=True, mode="json")
    trigger_changed["trigger"] = {
        "kind": "field-changed",
        "moduleId": "requests",
        "fieldId": "priority",
    }
    variants.append(TriggerDocument.model_validate(trigger_changed))
    condition_changed = desired.model_dump(by_alias=True, mode="json")
    condition_changed["conditionGroup"]["conditions"][0]["value"]["value"] = "Low"
    variants.append(TriggerDocument.model_validate(condition_changed))
    action_changed = desired.model_dump(by_alias=True, mode="json")
    action_changed["actions"][0]["value"]["value"] = "Done"
    variants.append(TriggerDocument.model_validate(action_changed))

    assert all(
        desired_trigger_signature(variant, module_bindings, field_bindings) != live_signature
        for variant in variants
    )


def test_relationship_scoped_trigger_references_block_publication() -> None:
    document = sandbox_document()
    base = document.triggers[0].model_dump(by_alias=True, mode="json")
    variants: list[TriggerDocument] = []

    condition_field = TriggerDocument.model_validate(base)
    condition_field.condition_group.conditions[0].field.relationship_id = "request-equipment"
    variants.append(condition_field)

    condition_value_payload = TriggerDocument.model_validate(base).model_dump(
        by_alias=True, mode="json"
    )
    condition_value_payload["conditionGroup"]["conditions"][0]["value"] = {
        "kind": "field-reference",
        "moduleId": "requests",
        "fieldId": "priority",
        "relationshipId": "request-equipment",
    }
    variants.append(TriggerDocument.model_validate(condition_value_payload))

    action_target = TriggerDocument.model_validate(base)
    action_target.actions[0].target.relationship_id = "request-equipment"
    variants.append(action_target)

    trigger_value_payload = TriggerDocument.model_validate(base).model_dump(
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
    variants.append(TriggerDocument.model_validate(trigger_value_payload))

    assert all(
        "trigger_relationship_reference_unsupported"
        in {blocker.code for blocker in _trigger_blockers(document, record_trigger)}
        for record_trigger in variants
    )


def test_invalid_select_configuration_returns_a_schema_blocker() -> None:
    document = sample_document().model_copy(deep=True)
    select_field = document.design.modules[0].fields[2]
    select_field.config.options = []

    blockers = module_schema_blockers(document)

    assert ("module_schema_invalid", "sample-requests") in {
        (blocker.code, blocker.target_id) for blocker in blockers
    }


def test_relationship_to_a_closed_module_does_not_make_an_empty_schema_valid() -> None:
    document = sample_document().model_copy(deep=True)
    source = document.design.modules[0]
    target = document.design.modules[1]
    for field in source.fields:
        field.closed = True
    target.closed = True

    blockers = module_schema_blockers(document)

    assert ("module_schema_invalid", "sample-requests") in {
        (blocker.code, blocker.target_id) for blocker in blockers
    }


def test_bound_fields_do_not_block_their_parent_module_from_closing() -> None:
    module_id = uuid7()
    field_id = uuid7()
    field = SimpleNamespace(id=field_id, type=FieldType.TEXT)
    database = Mock()
    database.scalars.return_value = [field]
    binding = SandboxBinding(
        kind="field",
        sandbox_id="sample-requests:sample-title",
        field_id=field_id,
    )

    assert not _module_has_unmanaged_fields(
        database,
        module_id,
        {binding.sandbox_id: binding},
        {},
    )


def test_closed_structure_names_do_not_block_later_active_names() -> None:
    document = sample_document().model_copy(deep=True)
    document.design.departments[0].closed = True
    document.design.departments[1].name = "Operations"
    document.design.modules[0].closed = True
    document.design.modules[1].name = "Service requests"

    assert not structure_name_blockers(document)
