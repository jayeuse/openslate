from collections.abc import Callable
from copy import deepcopy
from typing import Any

import pytest

from app.systems.sandbox.designs.validation import validate_document
from tests.sandbox_designs.fixtures import sample_document


def test_document_validation_reports_unknown_module_reference() -> None:
    document = {
        "kind": "openslate-sandbox",
        "schemaVersion": 4,
        "design": {
            "departments": [{"id": "department-1", "name": "Operations", "closed": False}],
            "modules": [],
            "relationships": [
                {
                    "id": "relationship-1",
                    "name": "Uses equipment",
                    "sourceModuleId": "module-missing",
                    "targetModuleId": "module-also-missing",
                    "cardinality": "one-to-many",
                    "fieldMappings": [],
                }
            ],
            "layout": {"department-1": {"x": 0, "y": 0, "width": 200, "height": 200}},
        },
        "triggers": [],
        "scenarios": [],
    }

    issues = validate_document(document)

    assert {issue.code for issue in issues} == {
        "relationship.source_module_missing",
        "relationship.target_module_missing",
    }


def test_release_validation_rejects_invalid_runnable_mapping_trigger_and_scenario() -> None:
    payload = sample_document().model_dump(by_alias=True)
    payload["design"]["relationships"][0]["fieldMappings"] = [
        {
            "sourceFieldId": "sample-field-requests-request-number",
            "targetFieldId": "sample-field-equipment-name",
        },
        {
            "sourceFieldId": "sample-field-requests-request-number",
            "targetFieldId": "sample-field-equipment-name",
        },
    ]
    payload["design"]["modules"][1]["fields"][1]["closed"] = True
    payload["triggers"].append(
        {
            "id": "trigger-invalid",
            "name": "Invalid reference",
            "enabled": True,
            "priority": 0,
            "trigger": {
                "kind": "field-changed",
                "moduleId": "sample-customers",
                "fieldId": "missing",
            },
            "conditionGroup": {"operator": "all", "conditions": []},
            "actions": [{"id": "action-invalid", "kind": "notification", "message": "Alert"}],
        }
    )
    payload["scenarios"].append(
        {
            "id": "scenario-invalid",
            "name": "Invalid scenario",
            "records": [{"id": "record-invalid", "moduleId": "missing", "values": {}}],
            "links": [],
        }
    )

    codes = {issue.code for issue in validate_document(payload)}

    assert {
        "relationship.mapping_field_closed",
        "relationship.mapping_duplicate",
        "trigger.field_missing",
        "scenario.module_missing",
    } <= codes


def test_validation_rejects_unsafe_reference_type_and_disconnected_relationship() -> None:
    payload = sample_document().model_dump(by_alias=True)
    payload["triggers"].append(
        {
            "id": "trigger-reference-invalid",
            "name": "Unsafe reference",
            "enabled": True,
            "priority": 0,
            "trigger": {"kind": "record-created", "moduleId": "sample-customers"},
            "conditionGroup": {
                "operator": "all",
                "conditions": [
                    {
                        "id": "condition-invalid",
                        "field": {
                            "moduleId": "sample-customers",
                            "fieldId": "sample-field-customers-status",
                        },
                        "operator": "=",
                        "value": {
                            "kind": "field-reference",
                            "moduleId": "sample-customers",
                            "fieldId": "sample-field-customers-customer-id",
                            "relationshipId": "sample-uses",
                        },
                    }
                ],
            },
            "actions": [{"id": "action-safe", "kind": "notification", "message": "Alert"}],
        }
    )

    codes = {issue.code for issue in validate_document(payload)}

    assert "trigger.relationship_module_mismatch" in codes
    assert "trigger.value_type_invalid" in codes


def _duplicate_department(design: dict[str, Any], _payload: dict[str, Any]) -> None:
    design["departments"].append(deepcopy(design["departments"][0]))


def _duplicate_module(design: dict[str, Any], _payload: dict[str, Any]) -> None:
    design["modules"].append(deepcopy(design["modules"][0]))


def _duplicate_field(design: dict[str, Any], _payload: dict[str, Any]) -> None:
    fields = design["modules"][0]["fields"]
    fields.append(deepcopy(fields[0]))


def _missing_department(design: dict[str, Any], _payload: dict[str, Any]) -> None:
    design["modules"][2]["departmentId"] = "missing-department"


def _missing_mapping_fields(design: dict[str, Any], _payload: dict[str, Any]) -> None:
    design["relationships"][0]["fieldMappings"] = [
        {"sourceFieldId": "missing-source", "targetFieldId": "missing-target"}
    ]


def _self_links(count: int) -> Callable[[dict[str, Any], dict[str, Any]], None]:
    def add(design: dict[str, Any], _payload: dict[str, Any]) -> None:
        self_link = deepcopy(design["relationships"][0])
        self_link.update(
            {
                "id": "self-link",
                "sourceModuleId": "sample-requests",
                "targetModuleId": "sample-requests",
                "fieldMappings": [],
            }
        )
        design["relationships"].extend(deepcopy(self_link) for _ in range(count))

    return add


def _missing_layout(design: dict[str, Any], _payload: dict[str, Any]) -> None:
    del design["layout"]["sample-customers"]


def _unknown_layout(design: dict[str, Any], _payload: dict[str, Any]) -> None:
    design["layout"]["unknown-layout"] = {"x": 0, "y": 0, "width": 100, "height": 100}


def _duplicate_trigger(_design: dict[str, Any], payload: dict[str, Any]) -> None:
    payload["triggers"].append(deepcopy(payload["triggers"][0]))


def _duplicate_scenario(_design: dict[str, Any], payload: dict[str, Any]) -> None:
    scenario = {
        "id": "duplicate-scenario",
        "name": "Duplicate scenario",
        "records": [],
        "links": [],
    }
    payload["scenarios"] = [scenario, deepcopy(scenario)]


@pytest.mark.parametrize(
    ("defect", "expected"),
    (
        pytest.param(
            _duplicate_department,
            [("department.id_duplicate", "Duplicate department ID", "sample-operations")],
            id="duplicate-department",
        ),
        pytest.param(
            _duplicate_module,
            [("module.id_duplicate", "Duplicate module ID", "sample-requests")],
            id="duplicate-module",
        ),
        pytest.param(
            _duplicate_field,
            [("field.id_duplicate", "Duplicate field ID", "sample-requests")],
            id="duplicate-field",
        ),
        pytest.param(
            _missing_department,
            [("module.department_missing", "Module department does not exist", "sample-customers")],
            id="missing-department",
        ),
        pytest.param(
            _missing_mapping_fields,
            [
                (
                    "relationship.source_field_missing",
                    "Relationship mapping source field does not exist on its source module",
                    "sample-uses",
                ),
                (
                    "relationship.target_field_missing",
                    "Relationship mapping target field does not exist on its target module",
                    "sample-uses",
                ),
            ],
            id="missing-mapping-fields",
        ),
        pytest.param(
            _self_links(1),
            [
                (
                    "relationship.self_link",
                    "A relationship cannot link a module to itself",
                    "self-link",
                )
            ],
            id="self-link",
        ),
        pytest.param(
            _self_links(2),
            [("relationship.id_duplicate", "Duplicate relationship ID", "self-link")],
            id="duplicate-relationship",
        ),
        pytest.param(
            _missing_layout,
            [
                (
                    "layout.entity_missing",
                    "Layout is required for every department and module",
                    "sample-customers",
                )
            ],
            id="missing-layout",
        ),
        pytest.param(
            _unknown_layout,
            [
                (
                    "layout.entity_missing",
                    "Layout references an unknown department or module",
                    "unknown-layout",
                )
            ],
            id="unknown-layout",
        ),
        pytest.param(
            _duplicate_trigger,
            [("trigger.id_duplicate", "Duplicate trigger ID", "sample-urgent")],
            id="duplicate-trigger",
        ),
        pytest.param(
            _duplicate_scenario,
            [("scenario.id_duplicate", "Duplicate scenario ID", "duplicate-scenario")],
            id="duplicate-scenario",
        ),
    ),
)
def test_validation_reports_each_structural_defect_with_its_target(
    defect: Callable[[dict[str, Any], dict[str, Any]], None],
    expected: list[tuple[str, str, str]],
) -> None:
    payload = sample_document().model_dump(by_alias=True, mode="json")
    defect(payload["design"], payload)
    codes = {code for code, _message, _target in expected}

    issues = [issue for issue in validate_document(payload) if issue.code in codes]

    assert [(issue.code, issue.message, issue.target_id) for issue in issues] == expected


def test_validation_preserves_duplicate_lookup_precedence_and_issue_order() -> None:
    payload = sample_document().model_dump(by_alias=True, mode="json")
    design = payload["design"]
    repeated_field = {
        "id": "repeated-field",
        "name": "Repeated field",
        "type": "Text",
        "required": False,
        "closed": False,
        "config": {"kind": "text", "defaultValue": ""},
    }
    design["modules"].extend(
        {
            "id": "sample-aa",
            "departmentId": "sample-operations",
            "name": "Repeated module",
            "closed": False,
            "fields": [deepcopy(repeated_field), deepcopy(repeated_field)],
        }
        for _ in range(3)
    )
    design["layout"]["sample-aa"] = {"x": 0, "y": 0, "width": 100, "height": 100}
    duplicate_module = deepcopy(design["modules"][0])
    duplicate_module["closed"] = True
    duplicate_module["fields"] = [
        {
            "id": "sample-field-requests-request-number",
            "name": "Request number",
            "type": "Number",
            "required": True,
            "closed": False,
            "config": {"kind": "number", "defaultValue": None},
        },
        {
            "id": "last-only",
            "name": "Last only",
            "type": "Text",
            "required": False,
            "closed": False,
            "config": {"kind": "text", "defaultValue": ""},
        },
    ]
    design["modules"].append(duplicate_module)

    first_relationship = design["relationships"][0]
    first_relationship["fieldMappings"] = [
        {
            "sourceFieldId": "sample-field-requests-request-number",
            "targetFieldId": "sample-field-equipment-name",
        }
    ]
    second_relationship = deepcopy(first_relationship)
    second_relationship.update(
        {
            "sourceModuleId": "sample-customers",
            "cardinality": "one-to-one",
            "fieldMappings": [
                {
                    "sourceFieldId": "sample-field-customers-customer-id",
                    "targetFieldId": "sample-field-equipment-status",
                }
            ],
        }
    )
    design["relationships"].append(second_relationship)
    payload["triggers"] = [
        {
            "id": "trigger-lookup",
            "name": "Duplicate lookup",
            "enabled": True,
            "priority": 0,
            "trigger": {"kind": "record-created", "moduleId": "sample-requests"},
            "conditionGroup": {
                "operator": "all",
                "conditions": [
                    {
                        "id": "condition-lookup",
                        "field": {"moduleId": "sample-requests", "fieldId": "last-only"},
                        "operator": "=",
                        "value": {"kind": "literal", "value": "x"},
                    }
                ],
            },
            "actions": [
                {
                    "id": "create-lookup",
                    "kind": "create-record",
                    "moduleId": "sample-requests",
                    "values": [
                        {"fieldId": "last-only", "value": {"kind": "literal", "value": "x"}}
                    ],
                }
            ],
        }
    ]
    payload["scenarios"] = [
        {
            "id": "scenario-lookup",
            "name": "Duplicate lookup",
            "records": [
                {"id": "request", "moduleId": "sample-requests", "values": {"last-only": "x"}},
                {"id": "equipment-1", "moduleId": "sample-equipment", "values": {}},
                {"id": "equipment-2", "moduleId": "sample-equipment", "values": {}},
            ],
            "links": [
                {
                    "relationshipId": "sample-uses",
                    "sourceRecordId": "request",
                    "targetRecordId": "equipment-1",
                },
                {
                    "relationshipId": "sample-uses",
                    "sourceRecordId": "request",
                    "targetRecordId": "equipment-2",
                },
            ],
        }
    ]

    issues = validate_document(payload)

    assert [(issue.code, issue.message, issue.target_id) for issue in issues] == [
        ("module.id_duplicate", "Duplicate module ID", "sample-aa"),
        ("module.id_duplicate", "Duplicate module ID", "sample-requests"),
        ("relationship.id_duplicate", "Duplicate relationship ID", "sample-uses"),
        ("field.id_duplicate", "Duplicate field ID", "sample-aa"),
        ("field.id_duplicate", "Duplicate field ID", "sample-aa"),
        ("field.id_duplicate", "Duplicate field ID", "sample-aa"),
        (
            "trigger.field_missing",
            "Trigger references a missing field",
            "trigger-lookup",
        ),
        (
            "trigger.field_missing",
            "Trigger action references a missing or closed field",
            "trigger-lookup",
        ),
        (
            "scenario.module_missing",
            "Scenario record references a missing or closed module",
            "scenario-lookup",
        ),
        (
            "scenario.field_missing",
            "Scenario value references a missing or closed field",
            "scenario-lookup",
        ),
        (
            "scenario.link_module_mismatch",
            "Scenario link does not match relationship modules",
            "scenario-lookup",
        ),
        (
            "scenario.link_module_mismatch",
            "Scenario link does not match relationship modules",
            "scenario-lookup",
        ),
        (
            "scenario.cardinality_invalid",
            "Scenario links violate one-to-one cardinality",
            "scenario-lookup",
        ),
    ]


def test_validation_exercises_trigger_and_scenario_reference_failures() -> None:
    payload = sample_document().model_dump(by_alias=True, mode="json")
    modules = payload["design"]["modules"]
    modules[2]["closed"] = True
    modules[0]["fields"][1]["closed"] = True
    payload["triggers"] = [
        {
            "id": "missing-trigger-module",
            "name": "Missing trigger module",
            "enabled": True,
            "priority": 0,
            "trigger": {"kind": "record-created", "moduleId": "missing"},
            "conditionGroup": {"operator": "all", "conditions": []},
            "actions": [{"id": "notice-1", "kind": "notification", "message": "Run"}],
        },
        {
            "id": "bad-references",
            "name": "Bad references",
            "enabled": True,
            "priority": 1,
            "trigger": {
                "kind": "threshold-crossed",
                "moduleId": "sample-requests",
                "fieldId": "sample-field-requests-status",
                "operator": "=",
                "value": {"kind": "literal", "value": 42},
            },
            "conditionGroup": {
                "operator": "all",
                "conditions": [
                    {
                        "id": "missing-relationship",
                        "field": {
                            "moduleId": "sample-requests",
                            "fieldId": "sample-field-requests-title",
                            "relationshipId": "missing-relationship",
                        },
                        "operator": "=",
                        "value": {"kind": "literal", "value": "x"},
                    },
                    {
                        "id": "missing-module",
                        "field": {"moduleId": "missing", "fieldId": "missing"},
                        "operator": "=",
                        "value": {"kind": "literal", "value": "x"},
                    },
                ],
            },
            "actions": [
                {
                    "id": "bad-set",
                    "kind": "set-field",
                    "target": {
                        "moduleId": "sample-requests",
                        "fieldId": "sample-field-requests-status",
                    },
                    "value": {"kind": "literal", "value": 42},
                },
                {
                    "id": "bad-create",
                    "kind": "create-record",
                    "moduleId": "sample-customers",
                    "values": [
                        {
                            "fieldId": "missing-field",
                            "value": {"kind": "literal", "value": "x"},
                        }
                    ],
                },
            ],
        },
    ]
    payload["design"]["relationships"][0]["cardinality"] = "one-to-one"
    payload["scenarios"] = [
        {
            "id": "broken-scenario",
            "name": "Broken scenario",
            "records": [
                {
                    "id": "request-1",
                    "moduleId": "sample-requests",
                    "values": {
                        "missing-field": "x",
                        "sample-field-requests-status": 42,
                    },
                },
                {"id": "request-1", "moduleId": "missing", "values": {}},
                {"id": "equipment-1", "moduleId": "sample-equipment", "values": {}},
                {"id": "equipment-2", "moduleId": "sample-equipment", "values": {}},
                {"id": "customer-1", "moduleId": "sample-customers", "values": {}},
            ],
            "links": [
                {
                    "relationshipId": "sample-uses",
                    "sourceRecordId": "request-1",
                    "targetRecordId": "equipment-1",
                },
                {
                    "relationshipId": "sample-uses",
                    "sourceRecordId": "request-1",
                    "targetRecordId": "equipment-2",
                },
                {
                    "relationshipId": "sample-uses",
                    "sourceRecordId": "request-1",
                    "targetRecordId": "equipment-1",
                },
                {
                    "relationshipId": "sample-uses",
                    "sourceRecordId": "customer-1",
                    "targetRecordId": "equipment-1",
                },
                {
                    "relationshipId": "missing-relationship",
                    "sourceRecordId": "missing-record",
                    "targetRecordId": "equipment-1",
                },
            ],
        }
    ]

    codes = {issue.code for issue in validate_document(payload)}

    assert {
        "trigger.module_missing",
        "trigger.reference_closed",
        "trigger.relationship_missing",
        "trigger.value_type_invalid",
        "trigger.field_missing",
        "scenario.record_id_duplicate",
        "scenario.module_missing",
        "scenario.field_missing",
        "scenario.value_type_invalid",
        "scenario.link_duplicate",
        "scenario.link_missing_reference",
        "scenario.link_module_mismatch",
        "scenario.cardinality_invalid",
    } <= codes
