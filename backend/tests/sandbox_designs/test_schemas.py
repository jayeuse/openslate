import json

import pytest

from app.systems.sandbox.designs.schemas import DesignField, SandboxDocument
from tests.sandbox_designs.fixtures import sample_document


def test_extreme_finite_number_default_is_checked_without_float_overflow() -> None:
    field = DesignField.model_validate(
        {
            "id": "extreme-number",
            "name": "Extreme number",
            "type": "Number",
            "config": {
                "kind": "number",
                "defaultValue": 1e308,
                "step": 1e-308,
            },
        }
    )

    assert field.config.default_value == 1e308


def test_datetime_configuration_uses_instant_comparisons_for_designer_values() -> None:
    field = DesignField.model_validate(
        {
            "id": "scheduled-at",
            "name": "Scheduled at",
            "type": "Date/Time",
            "config": {
                "kind": "datetime",
                "defaultValue": "2025-12-31T19:30:00-05:00",
                "earliest": "2026-01-01T00:00Z",
                "latest": "2026-01-01T01:00Z",
            },
        }
    )

    assert field.config.default_value == "2025-12-31T19:30:00-05:00"

    with pytest.raises(ValueError, match="defaultValue"):
        DesignField.model_validate(
            {
                "id": "outside-window",
                "name": "Outside window",
                "type": "Date/Time",
                "config": {
                    "kind": "datetime",
                    "defaultValue": "2025-12-31T18:59:00-05:00",
                    "earliest": "2026-01-01T00:00Z",
                    "latest": "2026-01-01T01:00Z",
                },
            }
        )


def test_document_typed_values_reject_non_finite_json_numbers() -> None:
    payload = sample_document().model_dump(by_alias=True, mode="json")
    payload["scenarios"] = [
        {
            "id": "non-finite-scenario",
            "name": "Non-finite scenario",
            "records": [
                {
                    "id": "record-1",
                    "moduleId": "sample-requests",
                    "values": {"sample-field-requests-priority": "NON_FINITE"},
                }
            ],
            "links": [],
        }
    ]
    raw = json.dumps(payload).replace('"NON_FINITE"', "1e400")

    with pytest.raises(ValueError):
        SandboxDocument.model_validate_json(raw)


def test_v4_frontend_fixture_preserves_exact_trigger_and_scenario_shapes() -> None:
    document = SandboxDocument.model_validate(
        {
            "kind": "openslate-sandbox",
            "schemaVersion": 4,
            "design": {
                "departments": [{"id": "department-1", "name": "Operations", "closed": False}],
                "modules": [
                    {
                        "id": "module-1",
                        "departmentId": "department-1",
                        "name": "Requests",
                        "closed": False,
                        "fields": [
                            {
                                "id": "field-1",
                                "name": "Priority",
                                "type": "Integer",
                                "required": False,
                                "closed": False,
                                "config": {"kind": "integer", "defaultValue": 1, "step": 1},
                            }
                        ],
                    }
                ],
                "relationships": [],
                "layout": {"module-1": {"x": 12, "y": 24, "width": 320, "height": 180}},
            },
            "triggers": [
                {
                    "id": "trigger-1",
                    "name": "Escalate",
                    "enabled": True,
                    "priority": 1,
                    "trigger": {
                        "kind": "threshold-crossed",
                        "moduleId": "module-1",
                        "fieldId": "field-1",
                        "operator": ">=",
                        "value": {"kind": "literal", "value": 1},
                    },
                    "conditionGroup": {
                        "operator": "all",
                        "conditions": [
                            {
                                "id": "condition-1",
                                "field": {"moduleId": "module-1", "fieldId": "field-1"},
                                "operator": "=",
                                "value": {"kind": "literal", "value": 1},
                            }
                        ],
                    },
                    "actions": [
                        {
                            "id": "action-1",
                            "kind": "set-field",
                            "target": {"moduleId": "module-1", "fieldId": "field-1"},
                            "value": {"kind": "literal", "value": 2},
                        }
                    ],
                }
            ],
            "scenarios": [
                {
                    "id": "scenario-1",
                    "name": "Urgent request",
                    "records": [
                        {"id": "record-1", "moduleId": "module-1", "values": {"field-1": 1}}
                    ],
                    "links": [],
                }
            ],
        }
    )

    payload = document.model_dump(by_alias=True, mode="json")

    assert payload["triggers"][0]["trigger"]["kind"] == "threshold-crossed"
    assert payload["scenarios"][0]["records"][0]["values"]["field-1"] == 1
    assert payload["design"]["layout"]["module-1"]["x"] == 12.0
