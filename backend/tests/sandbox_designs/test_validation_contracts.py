from copy import deepcopy

import pytest
from pydantic import ValidationError

from app.systems.sandbox.designs.schemas import (
    SandboxDocument,
    ValidationIssue,
    VersionCreateRequest,
    VersionMetadataUpdateRequest,
)
from app.systems.sandbox.designs.validation import validate_document
from tests.sandbox_designs.fixtures import sample_document


def _payload() -> dict[str, object]:
    return deepcopy(sample_document().model_dump(by_alias=True, mode="json"))


def test_schema_rejects_weekly_schedule_without_a_weekday_and_labels_over_80_characters() -> None:
    payload = _payload()
    payload["triggers"] = [
        {
            "id": "weekly",
            "name": "Weekly",
            "enabled": True,
            "priority": 0,
            "trigger": {
                "kind": "schedule",
                "moduleId": "requests",
                "frequency": "weekly",
                "time": "09:00",
            },
            "conditionGroup": {"operator": "all", "conditions": []},
            "actions": [{"id": "notice", "kind": "notification", "message": "Run"}],
        }
    ]

    with pytest.raises(ValidationError, match="weekday"):
        SandboxDocument.model_validate(payload)
    with pytest.raises(ValidationError):
        VersionCreateRequest.model_validate(
            {"expectedRevision": 1, "kind": "checkpoint", "label": "x" * 81}
        )
    with pytest.raises(ValidationError):
        VersionMetadataUpdateRequest.model_validate({"expectedRevision": 1, "label": "x" * 81})


def test_schema_rejects_a_document_with_more_than_5000_total_fields() -> None:
    payload = _payload()
    module = payload["design"]["modules"][0]
    field = module["fields"][0]
    module["fields"] = [
        {**field, "id": f"field-{index}", "name": f"Field {index}"} for index in range(5_001)
    ]

    with pytest.raises(ValidationError, match="5000"):
        SandboxDocument.model_validate(payload)


_MAPPING_SOURCE_FIELDS = [
    {
        "id": "source-number",
        "name": "Source number",
        "type": "Integer",
        "required": False,
        "closed": False,
        "config": {"kind": "integer", "defaultValue": 0, "min": 0, "max": 10, "step": 2},
    },
    {
        "id": "source-date",
        "name": "Source date",
        "type": "Date",
        "required": False,
        "closed": False,
        "config": {"kind": "date", "defaultValue": None, "earliest": "2024-01-01"},
    },
    {
        "id": "source-text",
        "name": "Source text",
        "type": "Text",
        "required": False,
        "closed": False,
        "config": {"kind": "text", "defaultValue": "", "maxLength": 80},
    },
]
_MAPPING_TARGET_FIELDS = [
    {
        "id": "target-number",
        "name": "Target number",
        "type": "Number",
        "required": True,
        "closed": False,
        "config": {"kind": "number", "defaultValue": None, "min": 1, "step": 3},
    },
    {
        "id": "target-date",
        "name": "Target date",
        "type": "Date",
        "required": False,
        "closed": False,
        "config": {"kind": "date", "defaultValue": None, "earliest": "2024-02-01"},
    },
    {
        "id": "target-text",
        "name": "Target text",
        "type": "Long text",
        "required": False,
        "closed": False,
        "config": {"kind": "long-text", "defaultValue": "", "maxLength": 40},
    },
]


@pytest.mark.parametrize(
    ("source_field_id", "target_field_id"),
    (
        # An optional integer from 0 in steps of 2 into a required number from 1 in steps of 3.
        ("source-number", "target-number"),
        # Dates from 2024-01-01 into a field that starts at 2024-02-01.
        ("source-date", "target-date"),
        # Text up to 80 characters into long text that holds 40.
        ("source-text", "target-text"),
    ),
    ids=("requiredness-range-and-step", "earliest-date", "text-length"),
)
def test_validation_refuses_each_mapping_that_can_carry_an_invalid_value(
    source_field_id: str, target_field_id: str
) -> None:
    payload = _payload()
    modules = payload["design"]["modules"]
    modules[0]["fields"] = deepcopy(_MAPPING_SOURCE_FIELDS)
    modules[1]["fields"] = deepcopy(_MAPPING_TARGET_FIELDS)
    payload["design"]["relationships"][0]["fieldMappings"] = [
        {"sourceFieldId": source_field_id, "targetFieldId": target_field_id}
    ]

    incompatible = [
        issue
        for issue in validate_document(payload)
        if issue.code == "relationship.mapping_incompatible"
    ]

    assert incompatible == [
        ValidationIssue(
            code="relationship.mapping_incompatible",
            message="Relationship mapping field types are incompatible",
            targetId="sample-uses",
        )
    ]


_FORMAT_FIELDS = [
    {
        "id": "number",
        "name": "Number",
        "type": "Number",
        "required": False,
        "closed": False,
        "config": {"kind": "number", "defaultValue": None, "min": 0, "max": 10, "step": 2},
    },
    {
        "id": "email",
        "name": "Email",
        "type": "Email",
        "required": False,
        "closed": False,
        "config": {"kind": "email", "defaultValue": ""},
    },
    {
        "id": "url",
        "name": "URL",
        "type": "URL",
        "required": False,
        "closed": False,
        "config": {"kind": "url", "defaultValue": ""},
    },
    {
        "id": "required-text",
        "name": "Required text",
        "type": "Text",
        "required": True,
        "closed": False,
        "config": {"kind": "text", "defaultValue": ""},
    },
    {
        "id": "date",
        "name": "Date",
        "type": "Date",
        "required": False,
        "closed": False,
        "config": {
            "kind": "date",
            "defaultValue": None,
            "earliest": "2024-01-01",
            "latest": "2024-12-31",
        },
    },
]


@pytest.mark.parametrize(
    ("field_id", "value"),
    (
        ("number", 3),  # off the step of 2 from 0
        ("email", "invalid"),
        ("url", "ftp://example.com"),  # not http or https
        ("required-text", "   "),  # blank after trimming
        ("date", "2024-02-30"),  # no such day
    ),
    ids=("number-step", "email", "url-scheme", "blank-required-text", "impossible-date"),
)
def test_validation_refuses_each_scenario_value_that_breaks_its_field(
    field_id: str, value: object
) -> None:
    payload = _payload()
    payload["design"]["modules"][0]["fields"] = deepcopy(_FORMAT_FIELDS)
    payload["scenarios"] = [
        {
            "id": "invalid-values",
            "name": "Invalid values",
            "records": [
                {"id": "record", "moduleId": "sample-requests", "values": {field_id: value}}
            ],
            "links": [],
        }
    ]

    invalid = [
        issue for issue in validate_document(payload) if issue.code == "scenario.value_type_invalid"
    ]

    assert invalid == [
        ValidationIssue(
            code="scenario.value_type_invalid",
            message="Scenario value does not match its field type",
            targetId="invalid-values",
        )
    ]


OLDER_FORMAT_MESSAGE = "This design uses an older format and cannot be opened."


@pytest.mark.parametrize("schema_version", (1, 2))
def test_schema_refuses_an_older_document_format_with_one_clear_message(
    schema_version: int,
) -> None:
    payload = _payload()
    payload["schemaVersion"] = schema_version
    payload["automations"] = payload.pop("triggers")

    with pytest.raises(ValidationError) as refused:
        SandboxDocument.model_validate(payload)

    assert [error["msg"] for error in refused.value.errors()] == [OLDER_FORMAT_MESSAGE]
