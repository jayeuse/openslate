"""Same-module trigger helpers for temporary-input tests."""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from app.systems.sandbox.designs.date_values import parse_datetime
from app.systems.sandbox.test_runs.results import SandboxTestIssue
from app.systems.sandbox.test_runs.schemas import TestValue

UNRESOLVED = object()
MISSING = object()


def resolve_trigger_value(
    raw_value: object, module_id: str, values: Mapping[str, TestValue]
) -> TestValue | object:
    if not isinstance(raw_value, Mapping):
        return UNRESOLVED
    if raw_value.get("kind") == "literal":
        literal = raw_value.get("value")
        return (
            literal
            if literal is None or isinstance(literal, (str, int, float, bool))
            else UNRESOLVED
        )
    field_id = raw_value.get("fieldId")
    if (
        raw_value.get("kind") == "field-reference"
        and raw_value.get("moduleId") == module_id
        and raw_value.get("relationshipId") is None
        and isinstance(field_id, str)
    ):
        return values[field_id] if field_id in values else MISSING
    return UNRESOLVED


def compare(left: object, operator: str, right: object, field_kind: str | None = None) -> bool:
    if left is MISSING or right is MISSING:
        return False
    if field_kind == "datetime":
        if not isinstance(left, str) or not isinstance(right, str):
            return False
        parsed_left = parse_datetime(left)
        parsed_right = parse_datetime(right)
        if parsed_left is None or parsed_right is None:
            return False
        left, right = parsed_left, parsed_right
    if operator == "=":
        return left == right
    if operator == "!=":
        return left != right
    if isinstance(left, bool) or isinstance(right, bool) or left is None or right is None:
        return False
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return {">": left > right, ">=": left >= right, "<": left < right, "<=": left <= right}.get(
            operator, False
        )
    if isinstance(left, str) and isinstance(right, str):
        return {">": left > right, ">=": left >= right, "<": left < right, "<=": left <= right}.get(
            operator, False
        )
    return False


def selected_triggers(
    by_id: Mapping[str, Mapping[str, object]],
    trigger_ids: Sequence[str] | None,
    issues: list[SandboxTestIssue],
) -> list[Mapping[str, object]]:
    if trigger_ids is None:
        return [item for item in by_id.values() if item.get("enabled") is True]
    selected = [
        record_trigger for trigger_id, record_trigger in by_id.items() if trigger_id in trigger_ids
    ]
    for trigger_id in trigger_ids:
        if trigger_id not in by_id:
            issues.append(
                SandboxTestIssue(
                    "trigger_invalid",
                    "A selected trigger is no longer available.",
                    trigger_id,
                )
            )
    return selected


def trigger_issue(
    issues: list[SandboxTestIssue], trigger_id: str | None, message: str
) -> None:
    issues.append(SandboxTestIssue("trigger_invalid", message, trigger_id))
