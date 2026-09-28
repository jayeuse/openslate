from copy import deepcopy

import pytest
from pydantic import ValidationError

from app.systems.sandbox.designs.schemas import (
    SandboxDocument,
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
        VersionMetadataUpdateRequest.model_validate(
            {"expectedRevision": 1, "label": "x" * 81}
        )


def test_schema_rejects_a_document_with_more_than_5000_total_fields() -> None:
    payload = _payload()
    module = payload["design"]["modules"][0]
    field = module["fields"][0]
    module["fields"] = [
        {**field, "id": f"field-{index}", "name": f"Field {index}"}
        for index in range(5_001)
    ]

    with pytest.raises(ValidationError, match="5000"):
        SandboxDocument.model_validate(payload)


def test_validation_enforces_mapping_requiredness_ranges_steps_dates_and_text_lengths() -> None:
    payload = _payload()
    modules = payload["design"]["modules"]
    source = modules[0]
    target = modules[1]
    source["fields"] = [
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
    target["fields"] = [
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
    payload["design"]["relationships"][0]["fieldMappings"] = [
        {"sourceFieldId": "source-number", "targetFieldId": "target-number"},
        {"sourceFieldId": "source-date", "targetFieldId": "target-date"},
        {"sourceFieldId": "source-text", "targetFieldId": "target-text"},
    ]

    codes = {issue.code for issue in validate_document(payload)}

    assert "relationship.mapping_incompatible" in codes


def test_validation_enforces_field_formats_constraints_and_required_strings() -> None:
    payload = _payload()
    payload["design"]["modules"][0]["fields"] = [
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
    payload["scenarios"] = [
        {
            "id": "invalid-values",
            "name": "Invalid values",
            "records": [
                {
                    "id": "record",
                    "moduleId": "sample-requests",
                    "values": {
                        "number": 3,
                        "email": "invalid",
                        "url": "ftp://example.com",
                        "required-text": "   ",
                        "date": "2024-02-30",
                    },
                }
            ],
            "links": [],
        }
    ]

    codes = {issue.code for issue in validate_document(payload)}

    assert "scenario.value_type_invalid" in codes


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
