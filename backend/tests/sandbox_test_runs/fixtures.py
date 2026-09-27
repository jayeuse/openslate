"""Focused document fixtures for Sandbox temporary-input tests."""

from __future__ import annotations

from copy import deepcopy

from app.systems.sandbox.designs.schemas import SandboxDocument


def sandbox_document() -> SandboxDocument:
    return SandboxDocument.model_validate(
        {
            "kind": "openslate-sandbox",
            "schemaVersion": 3,
            "design": {
                "departments": [
                    {"id": "operations", "name": "Operations"},
                    {"id": "service", "name": "Service"},
                ],
                "modules": [
                    {
                        "id": "requests",
                        "departmentId": "operations",
                        "name": "Requests",
                        "fields": [
                            {
                                "id": "priority",
                                "name": "Priority",
                                "type": "Select",
                                "required": True,
                                "config": {
                                    "kind": "select",
                                    "defaultValue": "Low",
                                    "options": ["Low", "High"],
                                },
                            },
                            {
                                "id": "status",
                                "name": "Status",
                                "type": "Text",
                                "config": {"kind": "text", "defaultValue": ""},
                            },
                            {
                                "id": "score",
                                "name": "Score",
                                "type": "Number",
                                "config": {"kind": "number", "defaultValue": 0, "min": 0},
                            },
                        ],
                    },
                    {
                        "id": "equipment",
                        "departmentId": "service",
                        "name": "Equipment",
                        "fields": [
                            {
                                "id": "priority-copy",
                                "name": "Priority copy",
                                "type": "Select",
                                "config": {
                                    "kind": "select",
                                    "defaultValue": "Low",
                                    "options": ["Low", "High"],
                                },
                            }
                        ],
                    },
                ],
                "relationships": [
                    {
                        "id": "request-equipment",
                        "name": "Uses equipment",
                        "sourceModuleId": "requests",
                        "targetModuleId": "equipment",
                        "cardinality": "one-to-many",
                        "fieldMappings": [
                            {"sourceFieldId": "priority", "targetFieldId": "priority-copy"}
                        ],
                    }
                ],
                "layout": {},
            },
            "triggers": [
                {
                    "id": "mark-high",
                    "name": "Mark high requests",
                    "enabled": True,
                    "priority": 10,
                    "trigger": {"kind": "record-created", "moduleId": "requests"},
                    "conditionGroup": {
                        "operator": "all",
                        "conditions": [
                            {
                                "id": "is-high",
                                "field": {"moduleId": "requests", "fieldId": "priority"},
                                "operator": "=",
                                "value": {"kind": "literal", "value": "High"},
                            }
                        ],
                    },
                    "actions": [
                        {
                            "id": "set-triaged",
                            "kind": "set-field",
                            "target": {"moduleId": "requests", "fieldId": "status"},
                            "value": {"kind": "literal", "value": "Triaged"},
                        }
                    ],
                },
                {
                    "id": "copy-triaged",
                    "name": "Copy triage",
                    "enabled": True,
                    "priority": 20,
                    "trigger": {"kind": "record-created", "moduleId": "requests"},
                    "conditionGroup": {
                        "operator": "all",
                        "conditions": [
                            {
                                "id": "is-triaged",
                                "field": {"moduleId": "requests", "fieldId": "status"},
                                "operator": "=",
                                "value": {"kind": "literal", "value": "Triaged"},
                            }
                        ],
                    },
                    "actions": [
                        {
                            "id": "set-score",
                            "kind": "set-field",
                            "target": {"moduleId": "requests", "fieldId": "score"},
                            "value": {"kind": "literal", "value": 10},
                        }
                    ],
                },
            ],
            "scenarios": [],
        }
    )


def document_payload() -> dict[str, object]:
    return deepcopy(sandbox_document().model_dump(by_alias=True, mode="json"))
