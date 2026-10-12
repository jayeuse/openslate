"""Exact issues for Sandbox trigger, scenario, relationship, and title references.

The Sandbox screen shows each issue as "Review: <message>", removes repeats by code, target and
message, and opens the target named by the issue (`page.tsx`, `issue-destination.ts`). Each row
therefore asserts the full (code, message, target) triple. The sample document is valid, so a row
lists every issue that its one defect causes.
"""

from collections.abc import Callable
from copy import deepcopy
from typing import Any

import pytest

from app.systems.sandbox.designs.validation import validate_document
from tests.sandbox_designs.fixtures import sample_document

Payload = dict[str, Any]
Change = Callable[[Payload], None]

REQUESTS = "sample-requests"
EQUIPMENT = "sample-equipment"
CUSTOMERS = "sample-customers"
TITLE = "sample-field-requests-title"
STATUS = "sample-field-requests-status"

INCOMPATIBLE_REFERENCE = (
    "trigger.value_type_invalid",
    "Trigger field reference is incompatible with its target field",
    "rule",
)


def _reference(module_id: str, field_id: str, relationship_id: str | None = None) -> Payload:
    return {"moduleId": module_id, "fieldId": field_id, "relationshipId": relationship_id}


def _field_value(module_id: str, field_id: str) -> Payload:
    return {"kind": "field-reference", **_reference(module_id, field_id)}


def _literal(value: object) -> Payload:
    return {"kind": "literal", "value": value}


def _rule(
    event: Payload | None = None,
    *,
    conditions: tuple[tuple[Payload, Payload], ...] = (),
    actions: tuple[Payload, ...] = (),
) -> Change:
    def change(payload: Payload) -> None:
        payload["triggers"] = [
            {
                "id": "rule",
                "name": "Rule",
                "enabled": True,
                "priority": 0,
                "trigger": event or {"kind": "record-created", "moduleId": REQUESTS},
                "conditionGroup": {
                    "operator": "all",
                    "conditions": [
                        {
                            "id": f"condition-{index}",
                            "field": field,
                            "operator": "=",
                            "value": value,
                        }
                        for index, (field, value) in enumerate(conditions)
                    ],
                },
                "actions": list(actions)
                or [{"id": "notice", "kind": "notification", "message": "Run"}],
            }
        ]

    return change


def _condition(field: Payload, value: Payload) -> Change:
    return _rule(conditions=((field, value),))


def _scenario(
    records: tuple[tuple[str, str], ...],
    links: tuple[tuple[str, str], ...] = (),
    *,
    cardinality: str | None = None,
    values: Payload | None = None,
) -> Change:
    def change(payload: Payload) -> None:
        if cardinality is not None:
            payload["design"]["relationships"][0]["cardinality"] = cardinality
        payload["scenarios"] = [
            {
                "id": "scenario",
                "name": "Scenario",
                "records": [
                    {"id": record_id, "moduleId": module_id, "values": dict(values or {})}
                    for record_id, module_id in records
                ],
                "links": [
                    {
                        "relationshipId": "sample-uses",
                        "sourceRecordId": source,
                        "targetRecordId": target,
                    }
                    for source, target in links
                ],
            }
        ]

    return change


def _closed(module_index: int, field_index: int | None = None) -> Change:
    def change(payload: Payload) -> None:
        module = payload["design"]["modules"][module_index]
        if field_index is None:
            module["closed"] = True
        else:
            module["fields"][field_index]["closed"] = True

    return change


def _both(*changes: Change) -> Change:
    def change(payload: Payload) -> None:
        for item in changes:
            item(payload)

    return change


def _orphan_relationship(payload: Payload) -> None:
    payload["design"]["relationships"].append(
        {
            "id": "orphan",
            "name": "Orphan",
            "sourceModuleId": "missing-source",
            "targetModuleId": "missing-target",
            "cardinality": "many-to-many",
            "fieldMappings": [{"sourceFieldId": "a", "targetFieldId": "b"}] * 2,
        }
    )


def _mappings_with_one_closed_field(payload: Payload) -> None:
    payload["design"]["modules"][1]["fields"][3]["closed"] = True
    payload["design"]["relationships"][0]["fieldMappings"] = [
        {
            "sourceFieldId": "sample-field-requests-request-number",
            "targetFieldId": "sample-field-equipment-asset-tag",
        },
        {"sourceFieldId": TITLE, "targetFieldId": "sample-field-equipment-name"},
        {
            "sourceFieldId": "sample-field-requests-priority",
            "targetFieldId": "sample-field-equipment-location",
        },
    ]


def _title(
    field_type: str | None, config: Payload | None = None, *, closed: bool = False
) -> Change:
    def change(payload: Payload) -> None:
        module = payload["design"]["modules"][2]
        if field_type is None:
            module["titleFieldId"] = "missing-field"
            return
        module["fields"].append(
            {
                "id": "title-candidate",
                "name": "Title candidate",
                "type": field_type,
                "required": False,
                "closed": closed,
                "config": config,
            }
        )
        module["titleFieldId"] = "title-candidate"

    return change


_TITLE_INVALID = (
    "module.title_field_invalid",
    "Choose an active title field in this module",
    CUSTOMERS,
)


@pytest.mark.parametrize(
    ("change", "expected"),
    (
        pytest.param(
            _rule({"kind": "record-created", "moduleId": "missing"}),
            [("trigger.module_missing", "Trigger references a missing module", "rule")],
            id="record-created-missing-module",
        ),
        pytest.param(
            _rule(
                {"kind": "schedule", "moduleId": "missing", "frequency": "daily", "time": "09:00"}
            ),
            [("trigger.module_missing", "Trigger references a missing module", "rule")],
            id="schedule-missing-module",
        ),
        pytest.param(
            _both(
                _closed(0, 1),
                _rule({"kind": "field-changed", "moduleId": REQUESTS, "fieldId": TITLE}),
            ),
            [("trigger.reference_closed", "Trigger references a closed entity", "rule")],
            id="field-changed-closed-field",
        ),
        pytest.param(
            _condition(_reference("missing", "missing"), _literal("x")),
            [("trigger.module_missing", "Trigger references a missing module", "rule")],
            id="condition-missing-module",
        ),
        pytest.param(
            _condition(_reference(REQUESTS, TITLE, "missing-relationship"), _literal("x")),
            [("trigger.relationship_missing", "Trigger references a missing relationship", "rule")],
            id="condition-missing-relationship",
        ),
        pytest.param(
            _condition(
                _reference(CUSTOMERS, "sample-field-customers-name", "sample-uses"), _literal("x")
            ),
            [
                (
                    "trigger.relationship_module_mismatch",
                    "Trigger relationship does not connect its referenced module",
                    "rule",
                )
            ],
            id="condition-relationship-elsewhere",
        ),
        pytest.param(
            _condition(_reference(REQUESTS, TITLE), _field_value("missing", "missing")),
            [("trigger.module_missing", "Trigger references a missing module", "rule")],
            id="value-reference-missing-module",
        ),
        pytest.param(
            _condition(_reference(REQUESTS, TITLE), _field_value(REQUESTS, "missing")),
            [("trigger.field_missing", "Trigger references a missing field", "rule")],
            id="value-reference-missing-field",
        ),
        pytest.param(
            # Status is optional, so only the literal itself can fail the select options.
            _condition(_reference(REQUESTS, STATUS), _literal("Not an option")),
            [
                (
                    "trigger.value_type_invalid",
                    "Trigger value does not match its target field type",
                    "rule",
                )
            ],
            id="condition-literal-not-an-option",
        ),
        pytest.param(
            _condition(_reference(REQUESTS, STATUS), _field_value(REQUESTS, TITLE)),
            [INCOMPATIBLE_REFERENCE],
            id="condition-text-reference-into-select",
        ),
        pytest.param(
            _rule(
                {
                    "kind": "threshold-crossed",
                    "moduleId": REQUESTS,
                    "fieldId": STATUS,
                    "operator": "=",
                    "value": _field_value(REQUESTS, TITLE),
                }
            ),
            [INCOMPATIBLE_REFERENCE],
            id="threshold-text-reference-into-select",
        ),
        pytest.param(
            _rule(
                actions=(
                    {
                        "id": "set",
                        "kind": "set-field",
                        "target": _reference(REQUESTS, "missing"),
                        "value": _literal("x"),
                    },
                )
            ),
            [("trigger.field_missing", "Trigger references a missing field", "rule")],
            id="set-field-missing-target",
        ),
        pytest.param(
            _rule(
                actions=(
                    {
                        "id": "set",
                        "kind": "set-field",
                        "target": _reference(REQUESTS, STATUS),
                        "value": _field_value(REQUESTS, TITLE),
                    },
                )
            ),
            [INCOMPATIBLE_REFERENCE],
            id="set-field-text-reference-into-select",
        ),
        pytest.param(
            _both(
                _closed(2),
                _rule(
                    actions=(
                        {
                            "id": "create",
                            "kind": "create-record",
                            "moduleId": CUSTOMERS,
                            "values": [],
                        },
                    )
                ),
            ),
            [
                (
                    "trigger.module_missing",
                    "Trigger action references a missing or closed module",
                    "rule",
                )
            ],
            id="create-record-closed-module",
        ),
        pytest.param(
            _rule(
                actions=(
                    {
                        "id": "create",
                        "kind": "create-record",
                        "moduleId": REQUESTS,
                        "values": [{"fieldId": STATUS, "value": _field_value(REQUESTS, TITLE)}],
                    },
                )
            ),
            [INCOMPATIBLE_REFERENCE],
            id="create-record-text-reference-into-select",
        ),
        pytest.param(
            _scenario((("record", REQUESTS), ("record", REQUESTS))),
            [("scenario.record_id_duplicate", "Duplicate scenario record ID", "scenario")],
            id="scenario-duplicate-record",
        ),
        pytest.param(
            # Many-to-many allows any count, so only the repeated link itself is wrong.
            _scenario(
                (("request", REQUESTS), ("equipment", EQUIPMENT)),
                (("request", "equipment"), ("request", "equipment")),
                cardinality="many-to-many",
            ),
            [("scenario.link_duplicate", "Duplicate scenario relationship link", "scenario")],
            id="scenario-duplicate-link",
        ),
        pytest.param(
            _scenario((("equipment", EQUIPMENT),), (("missing", "equipment"),)),
            [
                (
                    "scenario.link_missing_reference",
                    "Scenario link references a missing entity",
                    "scenario",
                )
            ],
            id="scenario-link-missing-source",
        ),
        pytest.param(
            _scenario((("request", REQUESTS),), (("request", "missing"),)),
            [
                (
                    "scenario.link_missing_reference",
                    "Scenario link references a missing entity",
                    "scenario",
                )
            ],
            id="scenario-link-missing-target",
        ),
        pytest.param(
            _scenario((("request", REQUESTS), ("customer", CUSTOMERS)), (("request", "customer"),)),
            [
                (
                    "scenario.link_module_mismatch",
                    "Scenario link does not match relationship modules",
                    "scenario",
                )
            ],
            id="scenario-link-target-in-other-module",
        ),
        pytest.param(
            # One request has many equipment items, so one equipment item has one request.
            _scenario(
                (("request-1", REQUESTS), ("request-2", REQUESTS), ("equipment", EQUIPMENT)),
                (("request-1", "equipment"), ("request-2", "equipment")),
            ),
            [
                (
                    "scenario.cardinality_invalid",
                    "Scenario links violate one-to-many cardinality",
                    "scenario",
                )
            ],
            id="scenario-one-to-many-target-shared",
        ),
        pytest.param(
            _orphan_relationship,
            [
                (
                    "relationship.mapping_duplicate",
                    "Duplicate relationship field mapping",
                    "orphan",
                ),
                (
                    "relationship.source_field_missing",
                    "Relationship mapping source field does not exist on its source module",
                    "orphan",
                ),
                (
                    "relationship.source_field_missing",
                    "Relationship mapping source field does not exist on its source module",
                    "orphan",
                ),
                (
                    "relationship.source_module_missing",
                    "Relationship source module does not exist",
                    "orphan",
                ),
                (
                    "relationship.target_field_missing",
                    "Relationship mapping target field does not exist on its target module",
                    "orphan",
                ),
                (
                    "relationship.target_field_missing",
                    "Relationship mapping target field does not exist on its target module",
                    "orphan",
                ),
                (
                    "relationship.target_module_missing",
                    "Relationship target module does not exist",
                    "orphan",
                ),
            ],
            id="relationship-missing-modules-with-repeated-mapping",
        ),
        pytest.param(
            # Two distinct compatible mappings are not duplicates; the third uses a closed field.
            _mappings_with_one_closed_field,
            [
                (
                    "relationship.mapping_field_closed",
                    "Relationship mappings cannot use closed fields",
                    "sample-uses",
                )
            ],
            id="relationship-mapping-closed-field",
        ),
        pytest.param(_title(None), [_TITLE_INVALID], id="title-missing-field"),
        pytest.param(
            _title("Date", {"kind": "date", "defaultValue": None}),
            [_TITLE_INVALID],
            id="title-date-field",
        ),
        pytest.param(
            _title("Text", {"kind": "text", "defaultValue": ""}, closed=True),
            [_TITLE_INVALID],
            id="title-closed-field-in-open-module",
        ),
    ),
)
def test_validation_reports_each_reference_defect_with_its_exact_issue(
    change: Change, expected: list[tuple[str, str, str]]
) -> None:
    payload = deepcopy(sample_document().model_dump(by_alias=True, mode="json"))
    change(payload)

    issues = validate_document(payload)

    assert sorted((issue.code, issue.message, issue.target_id) for issue in issues) == expected


@pytest.mark.parametrize(
    "change",
    (
        pytest.param(_title("Text", {"kind": "text", "defaultValue": ""}), id="title-text"),
        pytest.param(
            _title("Long text", {"kind": "long-text", "defaultValue": ""}), id="title-long-text"
        ),
        pytest.param(_title("Email", {"kind": "email", "defaultValue": ""}), id="title-email"),
        pytest.param(_title("URL", {"kind": "url", "defaultValue": ""}), id="title-url"),
        pytest.param(
            _title("Integer", {"kind": "integer", "defaultValue": None}), id="title-integer"
        ),
        pytest.param(_title("Number", {"kind": "number", "defaultValue": None}), id="title-number"),
        pytest.param(
            _title(
                "Select",
                {
                    "kind": "select",
                    "defaultValue": None,
                    "options": [{"id": "6f1c5a43-4f7e-4f6b-9a8e-2d3c4b5a6f70", "label": "Open"}],
                },
            ),
            id="title-select",
        ),
        pytest.param(
            _scenario(
                (("request", REQUESTS), ("equipment", EQUIPMENT)),
                (("request", "equipment"),),
                cardinality="one-to-one",
            ),
            id="scenario-one-to-one-single-link",
        ),
        pytest.param(
            _scenario(
                (("request", REQUESTS), ("equipment-1", EQUIPMENT), ("equipment-2", EQUIPMENT)),
                (("request", "equipment-1"), ("request", "equipment-2")),
            ),
            id="scenario-one-to-many-fan-out",
        ),
        pytest.param(
            # Text, an empty optional text, and null on an optional select all fit their fields.
            _scenario(
                (("request", REQUESTS),),
                values={TITLE: "Pump", "sample-field-requests-priority": "", STATUS: None},
            ),
            id="scenario-valid-values",
        ),
    ),
)
def test_validation_accepts_each_valid_reference(change: Change) -> None:
    payload = deepcopy(sample_document().model_dump(by_alias=True, mode="json"))
    change(payload)

    assert validate_document(payload) == []
