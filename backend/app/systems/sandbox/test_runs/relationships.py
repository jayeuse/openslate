"""Read-only relationship route and mapping projection for Sandbox tests."""

from __future__ import annotations

from collections.abc import Mapping
from typing import cast

from app.systems.sandbox.designs.field_validation import (
    DocumentValueError,
    validate_mapping,
    validate_value,
)
from app.systems.sandbox.designs.mapping_validation import field_metadata
from app.systems.sandbox.designs.schemas import DesignField
from app.systems.sandbox.test_runs.results import SandboxTestIssue, SandboxTestRoute
from app.systems.sandbox.test_runs.schemas import TestValue


def relationship_routes(
    *,
    design: Mapping[str, object],
    departments: Mapping[str, str],
    modules: Mapping[str, Mapping[str, object]],
    source_module: Mapping[str, object],
    values: Mapping[str, TestValue],
    issues: list[SandboxTestIssue],
) -> list[SandboxTestRoute]:
    raw_relationships = design.get("relationships")
    if not isinstance(raw_relationships, list):
        return []
    source_id = _string(source_module.get("id"))
    source_name = _string(source_module.get("name")) or "Selected module"
    source_department = departments.get(
        _string(source_module.get("departmentId")) or "", "Department"
    )
    routes: list[SandboxTestRoute] = []
    for raw_relationship in raw_relationships:
        relationship = _mapping(raw_relationship, "relationship")
        if relationship.get("sourceModuleId") != source_id:
            continue
        relationship_id = _string(relationship.get("id"))
        target_id = _string(relationship.get("targetModuleId"))
        target = modules.get(target_id or "")
        if relationship_id is None or target is None:
            issues.append(
                SandboxTestIssue(
                    "relationship_invalid",
                    "A relationship refers to an unavailable module.",
                    relationship_id,
                )
            )
            continue
        target_name = _string(target.get("name")) or "Target module"
        target_department = departments.get(_string(target.get("departmentId")) or "", "Department")
        relationship_name = _string(relationship.get("name")) or "Relationship"
        cardinality = _cardinality_detail(relationship.get("cardinality"), source_name, target_name)
        projections = _relationship_projections(relationship, source_module, target, values, issues)
        detail_parts = [f"{relationship_name}: {cardinality}"]
        if projections:
            detail_parts.append("Projects " + "; ".join(projections))
        routes.append(
            SandboxTestRoute(
                label=f"{source_department} / {source_name} → {target_department} / {target_name}",
                detail=". ".join(detail_parts),
            )
        )
    return routes


def _relationship_projections(
    relationship: Mapping[str, object],
    source_module: Mapping[str, object],
    target_module: Mapping[str, object],
    values: Mapping[str, TestValue],
    issues: list[SandboxTestIssue],
) -> list[str]:
    relationship_id = _string(relationship.get("id"))
    mappings = relationship.get("fieldMappings")
    if not isinstance(mappings, list):
        issues.append(
            SandboxTestIssue(
                "relationship_invalid", "Relationship mappings need attention.", relationship_id
            )
        )
        return []
    source_fields = _fields(source_module)
    target_fields = _fields(target_module)
    projections: list[str] = []
    for raw_mapping in mappings:
        mapping = _mapping(raw_mapping, "relationship mapping")
        source_id = _string(mapping.get("sourceFieldId"))
        target_id = _string(mapping.get("targetFieldId"))
        source = source_fields.get(source_id or "")
        target = target_fields.get(target_id or "")
        if source is None or target is None or not _mapping_is_compatible(source, target):
            issues.append(
                SandboxTestIssue(
                    "relationship_invalid",
                    "A relationship mapping is not compatible.",
                    relationship_id,
                )
            )
            continue
        if source_id is None or target_id is None or source_id not in values:
            continue
        value = values[source_id]
        if not _value_is_valid(value, target):
            issues.append(
                SandboxTestIssue(
                    "relationship_invalid",
                    "A projected relationship value is not compatible.",
                    relationship_id,
                )
            )
            continue
        source_name = _string(source.get("name")) or source_id
        target_name = _string(target.get("name")) or target_id
        projections.append(f"{source_name} to {target_name} = {value!r}")
    return projections


def _mapping_is_compatible(source: Mapping[str, object], target: Mapping[str, object]) -> bool:
    try:
        validate_mapping(
            field_metadata(DesignField.model_validate(source)),
            field_metadata(DesignField.model_validate(target)),
            "relationship",
        )
    except (DocumentValueError, ValueError):
        return False
    else:
        return True


def _value_is_valid(value: TestValue, field: Mapping[str, object]) -> bool:
    try:
        validate_value(value, field_metadata(DesignField.model_validate(field)))
    except (DocumentValueError, ValueError):
        return False
    else:
        return True


def _fields(module: Mapping[str, object]) -> dict[str, Mapping[str, object]]:
    raw_fields = module.get("fields")
    if not isinstance(raw_fields, list):
        return {}
    fields: dict[str, Mapping[str, object]] = {}
    for raw_field in raw_fields:
        field = _mapping(raw_field, "field")
        field_id = _string(field.get("id"))
        if field_id is not None:
            fields[field_id] = field
    return fields


def _mapping(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"Sandbox {label} is invalid")
    return cast(Mapping[str, object], value)


def _string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _cardinality_detail(value: object, source_name: str, target_name: str) -> str:
    labels = {
        "one-to-one": f"one {source_name} item can connect to one {target_name} item",
        "one-to-many": f"one {source_name} item can connect to many {target_name} items",
        "many-to-many": f"{source_name} and {target_name} items can connect to many on either side",
    }
    return (
        labels.get(value, "relationship settings need attention")
        if isinstance(value, str)
        else ("relationship settings need attention")
    )
