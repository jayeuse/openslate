"""Defensive helper contracts for temporary Test evaluation."""

import pytest

from app.systems.sandbox.test_runs.relationships import (
    _cardinality_detail,
    _fields,
    _mapping,
    _mapping_is_compatible,
    _value_is_valid,
    relationship_routes,
)
from app.systems.sandbox.test_runs.trigger_values import (
    UNRESOLVED,
    compare,
    resolve_trigger_value,
    trigger_issue,
)


def _field(field_id: str, kind: str, **config: object) -> dict[str, object]:
    field_type = {
        "text": "Text",
        "long-text": "Long text",
        "email": "Email",
        "url": "URL",
        "number": "Number",
        "integer": "Integer",
        "date": "Date",
        "datetime": "Date/Time",
        "checkbox": "Checkbox",
        "select": "Select",
    }[kind]
    return {
        "id": field_id,
        "name": field_id.title(),
        "type": field_type,
        "required": False,
        "closed": False,
        "config": {"kind": kind, **config},
    }


def test_trigger_values_fail_closed_and_compare_supported_scalars() -> None:
    values = {"status": "Open"}
    assert resolve_trigger_value("bad", "requests", values) is UNRESOLVED
    bad_literal = {"kind": "literal", "value": ["bad"]}
    assert resolve_trigger_value(bad_literal, "requests", values) is UNRESOLVED
    assert resolve_trigger_value({"kind": "literal", "value": False}, "requests", values) is False
    assert (
        resolve_trigger_value(
            {"kind": "field-reference", "moduleId": "requests", "fieldId": "status"},
            "requests",
            values,
        )
        == "Open"
    )
    assert (
        resolve_trigger_value(
            {
                "kind": "field-reference",
                "moduleId": "requests",
                "fieldId": "status",
                "relationshipId": "other",
            },
            "requests",
            values,
        )
        is UNRESOLVED
    )
    assert compare(1, "=", 1)
    assert compare(1, "!=", 2)
    assert compare(True, ">", False) is False
    assert compare(2, ">=", 1)
    assert compare("b", ">", "a")
    assert compare("1", ">", 1) is False
    assert not compare(
        "2025-01-01T01:00:00+02:00",
        ">=",
        "2025-01-01T00:00:00Z",
        "datetime",
    )
    assert compare(
        "2025-01-01T00:00:00Z",
        "=",
        "2025-01-01T00:00:00+00:00",
        "datetime",
    )

    issues = []
    trigger_issue(issues, "trigger", "Needs attention")
    assert issues[0].target_id == "trigger"


def test_relationship_routes_report_invalid_shapes_and_project_safe_values() -> None:
    issues = []
    source = {
        "id": "requests",
        "name": "Requests",
        "departmentId": "operations",
        "fields": [_field("priority", "text", maxLength=20)],
    }
    target = {
        "id": "equipment",
        "name": "Equipment",
        "departmentId": "service",
        "fields": [_field("priority-copy", "text", maxLength=20)],
    }
    departments = {"operations": "Operations", "service": "Service"}
    modules = {"requests": source, "equipment": target}

    assert (
        relationship_routes(
            design={},
            departments=departments,
            modules=modules,
            source_module=source,
            values={},
            issues=issues,
        )
        == []
    )
    assert (
        relationship_routes(
            design={"relationships": [{"sourceModuleId": "other"}]},
            departments=departments,
            modules=modules,
            source_module=source,
            values={},
            issues=issues,
        )
        == []
    )
    relationship_routes(
        design={"relationships": [{"id": "missing", "sourceModuleId": "requests"}]},
        departments=departments,
        modules=modules,
        source_module=source,
        values={},
        issues=issues,
    )
    relationship_routes(
        design={
            "relationships": [
                {
                    "id": "bad-mappings",
                    "sourceModuleId": "requests",
                    "targetModuleId": "equipment",
                    "fieldMappings": "bad",
                }
            ]
        },
        departments=departments,
        modules=modules,
        source_module=source,
        values={},
        issues=issues,
    )
    relationship_routes(
        design={
            "relationships": [
                {
                    "id": "bad-field",
                    "sourceModuleId": "requests",
                    "targetModuleId": "equipment",
                    "fieldMappings": [
                        {"sourceFieldId": "missing", "targetFieldId": "priority-copy"}
                    ],
                }
            ]
        },
        departments=departments,
        modules=modules,
        source_module=source,
        values={},
        issues=issues,
    )
    source["fields"] = [_field("priority", "number")]
    target["fields"] = [_field("priority-copy", "number")]
    relationship_routes(
        design={
            "relationships": [
                {
                    "id": "bad-value",
                    "sourceModuleId": "requests",
                    "targetModuleId": "equipment",
                    "fieldMappings": [
                        {"sourceFieldId": "priority", "targetFieldId": "priority-copy"}
                    ],
                }
            ]
        },
        departments=departments,
        modules=modules,
        source_module=source,
        values={"priority": "High"},
        issues=issues,
    )
    source["fields"] = [_field("priority", "text", maxLength=20)]
    target["fields"] = [_field("priority-copy", "text", maxLength=20)]
    routes = relationship_routes(
        design={
            "relationships": [
                {
                    "id": "valid",
                    "name": "Copies priority",
                    "sourceModuleId": "requests",
                    "targetModuleId": "equipment",
                    "cardinality": "one-to-many",
                    "fieldMappings": [
                        {"sourceFieldId": "priority", "targetFieldId": "priority-copy"}
                    ],
                }
            ]
        },
        departments=departments,
        modules=modules,
        source_module=source,
        values={"priority": "High"},
        issues=issues,
    )

    assert "Projects Priority to Priority-Copy = 'High'" in (routes[0].detail or "")
    assert {issue.target_id for issue in issues} == {
        "missing",
        "bad-mappings",
        "bad-field",
        "bad-value",
    }


def test_relationship_helper_compatibility_and_value_types_are_bounded() -> None:
    assert _mapping_is_compatible(
        _field("a", "select", options=["Open"]),
        _field("b", "select", options=["Open", "Done"]),
    )
    assert _mapping_is_compatible(_field("a", "integer"), _field("b", "number"))
    assert _mapping_is_compatible(_field("a", "email"), _field("b", "text"))
    assert not _mapping_is_compatible(_field("a", "number"), _field("b", "text"))
    assert not _mapping_is_compatible(
        _field("a", "number", min=0, max=100),
        _field("b", "number", min=0, max=10),
    )

    assert _value_is_valid(None, _field("a", "text"))
    assert not _value_is_valid(None, {**_field("a", "text"), "required": True})
    assert _value_is_valid(True, _field("a", "checkbox"))
    assert _value_is_valid(1, _field("a", "integer"))
    assert not _value_is_valid(True, _field("a", "number"))
    assert _value_is_valid("Open", _field("a", "select", options=["Open"]))
    assert _value_is_valid("2026-09-21", _field("a", "date"))
    assert not _value_is_valid(50, _field("a", "number", min=0, max=10))

    assert _fields({}) == {}
    with pytest.raises(ValueError, match="Sandbox field is invalid"):
        _fields({"fields": ["bad"]})
    with pytest.raises(ValueError, match="Sandbox relationship is invalid"):
        _mapping("bad", "relationship")
    assert "many on either side" in _cardinality_detail("many-to-many", "A", "B")
    assert _cardinality_detail(None, "A", "B") == "relationship settings need attention"
