"""Configured Sandbox documents used only by backend tests."""

from __future__ import annotations

from uuid import NAMESPACE_URL, uuid5

from app.systems.sandbox.designs.schemas import SandboxDocument
from tests.sandbox_documents import sandbox_document_payload, trigger_payload


def sample_option_id(field_id: str, label: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"{field_id}:{label}"))


def _text(field_id: str, name: str, *, required: bool = False) -> dict[str, object]:
    return {
        "id": field_id,
        "name": name,
        "type": "Text",
        "required": required,
        "closed": False,
        "config": {"kind": "text", "defaultValue": ""},
    }


def _status(field_id: str) -> dict[str, object]:
    options = ("Open", "In progress", "Complete")
    return {
        "id": field_id,
        "name": "Status",
        "type": "Select",
        "required": False,
        "closed": False,
        "config": {
            "kind": "select",
            "defaultValue": None,
            "options": [
                {"id": sample_option_id(field_id, label), "label": label}
                for label in options
            ],
        },
    }


def sample_document() -> SandboxDocument:
    """Return isolated graph data for validation and publication tests."""

    return SandboxDocument.model_validate(
        sandbox_document_payload(
            design={
                "departments": [
                    {"id": "sample-operations", "name": "Operations", "closed": False},
                    {"id": "sample-commercial", "name": "Commercial", "closed": False},
                ],
                "modules": [
                    {
                        "id": "sample-requests",
                        "departmentId": "sample-operations",
                        "name": "Service requests",
                        "closed": False,
                        "fields": [
                            _text(
                                "sample-field-requests-request-number",
                                "Request number",
                                required=True,
                            ),
                            _text("sample-field-requests-title", "Title"),
                            _status("sample-field-requests-status"),
                            _text("sample-field-requests-priority", "Priority"),
                        ],
                    },
                    {
                        "id": "sample-equipment",
                        "departmentId": "sample-operations",
                        "name": "Equipment",
                        "closed": False,
                        "fields": [
                            _text(
                                "sample-field-equipment-asset-tag",
                                "Asset tag",
                                required=True,
                            ),
                            _text("sample-field-equipment-name", "Name"),
                            _status("sample-field-equipment-status"),
                            _text("sample-field-equipment-location", "Location"),
                        ],
                    },
                    {
                        "id": "sample-customers",
                        "departmentId": "sample-commercial",
                        "name": "Customers",
                        "closed": False,
                        "fields": [
                            _text(
                                "sample-field-customers-customer-id",
                                "Customer ID",
                                required=True,
                            ),
                            _text("sample-field-customers-name", "Name"),
                            _status("sample-field-customers-status"),
                            _text("sample-field-customers-email", "Email"),
                        ],
                    },
                ],
                "relationships": [
                    {
                        "id": "sample-uses",
                        "name": "Uses equipment",
                        "sourceModuleId": "sample-requests",
                        "targetModuleId": "sample-equipment",
                        "cardinality": "one-to-many",
                        "fieldMappings": [],
                    }
                ],
                "layout": {
                    "sample-operations": {"x": 24, "y": 24, "width": 656, "height": 240},
                    "sample-commercial": {"x": 184, "y": 296, "width": 336, "height": 240},
                    "sample-requests": {"x": 48, "y": 72, "width": 280, "height": 168},
                    "sample-equipment": {"x": 376, "y": 72, "width": 280, "height": 168},
                    "sample-customers": {"x": 208, "y": 344, "width": 280, "height": 168},
                },
            },
            triggers=[
                trigger_payload(
                    "sample-urgent", "Urgent request alert",
                    enabled=True,
                    priority=0,
                    trigger={"kind": "record-created", "moduleId": "sample-requests"},
                    condition_group={
                        "operator": "all",
                        "conditions": [
                            {
                                "id": "sample-urgent-priority",
                                "field": {
                                    "moduleId": "sample-requests",
                                    "fieldId": "sample-field-requests-priority",
                                },
                                "operator": "=",
                                "value": {"kind": "literal", "value": "Urgent"},
                            }
                        ],
                    },
                    actions=[
                        {
                            "id": "sample-urgent-notification",
                            "kind": "notification",
                            "message": "Send a notification",
                        }
                    ],
                )
            ],
            scenarios=[],
        )
    )
