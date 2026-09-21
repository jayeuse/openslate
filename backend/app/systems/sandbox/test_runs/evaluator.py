"""Pure evaluation of temporary Sandbox input values."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from datetime import datetime
from math import isfinite
from typing import cast
from urllib.parse import urlparse

from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.numeric import numeric_matches_step
from app.systems.sandbox.test_runs.automation_values import (
    MISSING,
    UNRESOLVED,
    automation_issue,
    automation_value,
    compare,
    selected_automations,
)
from app.systems.sandbox.test_runs.relationships import relationship_routes
from app.systems.sandbox.test_runs.results import (
    SandboxTestAutomationTrace,
    SandboxTestIssue,
    SandboxTestResult,
)
from app.systems.sandbox.test_runs.schemas import TestValue


def evaluate_test(
    *,
    document: SandboxDocument,
    module_id: str,
    values: Mapping[str, TestValue],
    event: Mapping[str, object],
    automation_ids: Sequence[str] | None,
) -> SandboxTestResult:
    design = _mapping(document.design.model_dump(by_alias=True, mode="json"), "design")
    modules = _modules(design)
    departments = _departments(design)
    module = modules.get(module_id)
    issues: list[SandboxTestIssue] = []
    if module is None or _boolean(module.get("closed")):
        return SandboxTestResult(
            values={},
            routes=(),
            automation_traces=(),
            issues=(
                SandboxTestIssue(
                    "module_invalid", "Choose an active module before running a test."
                ),
            ),
        )

    result_values = _validated_values(module, values, issues)
    routes = relationship_routes(
        design=design,
        departments=departments,
        modules=modules,
        source_module=module,
        values=result_values,
        issues=issues,
    )
    if issues:
        return SandboxTestResult(
            values=result_values,
            routes=tuple(routes),
            automation_traces=(),
            issues=tuple(issues),
        )

    traces = _apply_automations(
        document=document,
        module_id=module_id,
        module=module,
        values=result_values,
        event=event,
        automation_ids=automation_ids,
        issues=issues,
    )
    routes = relationship_routes(
        design=design,
        departments=departments,
        modules=modules,
        source_module=module,
        values=result_values,
        issues=issues,
    )
    return SandboxTestResult(
        values=result_values,
        routes=tuple(routes),
        automation_traces=tuple(traces),
        issues=tuple(issues),
    )

def _mapping(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"Sandbox {label} is invalid")
    return cast(Mapping[str, object], value)

def _string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None

def _boolean(value: object) -> bool:
    return value is True


def _modules(design: Mapping[str, object]) -> dict[str, Mapping[str, object]]:
    raw_modules = design.get("modules")
    if not isinstance(raw_modules, list):
        raise ValueError("Sandbox modules are invalid")
    modules: dict[str, Mapping[str, object]] = {}
    for raw_module in raw_modules:
        module = _mapping(raw_module, "module")
        module_id = _string(module.get("id"))
        if module_id is not None:
            modules[module_id] = module
    return modules


def _departments(design: Mapping[str, object]) -> dict[str, str]:
    raw_departments = design.get("departments")
    if not isinstance(raw_departments, list):
        return {}
    departments: dict[str, str] = {}
    for raw_department in raw_departments:
        department = _mapping(raw_department, "department")
        department_id = _string(department.get("id"))
        name = _string(department.get("name"))
        if department_id is not None and name is not None:
            departments[department_id] = name
    return departments


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


def _validated_values(
    module: Mapping[str, object], values: Mapping[str, TestValue], issues: list[SandboxTestIssue]
) -> dict[str, TestValue]:
    fields = _fields(module)
    valid_values: dict[str, TestValue] = {}
    for field_id, value in values.items():
        field = fields.get(field_id)
        if field is None or _boolean(field.get("closed")):
            issues.append(
                SandboxTestIssue(
                    "field_invalid", "A temporary value refers to an unavailable field.", field_id
                )
            )
            continue
        if not _value_is_valid(value, field):
            issues.append(
                SandboxTestIssue(
                    "value_invalid",
                    "A temporary value does not match its field settings.",
                    field_id,
                )
            )
            continue
        valid_values[field_id] = value
    for field_id, field in fields.items():
        if _boolean(field.get("closed")) or not _boolean(field.get("required")):
            continue
        if _value_is_empty(valid_values.get(field_id)):
            issues.append(
                SandboxTestIssue(
                    "value_required", "Enter a value for this required field.", field_id
                )
            )
    return valid_values


def _value_is_empty(value: TestValue | None) -> bool:
    return value is None or isinstance(value, str) and not value.strip()


def _value_is_valid(value: TestValue, field: Mapping[str, object]) -> bool:
    if value is None:
        return not _boolean(field.get("required"))
    if isinstance(value, str) and _boolean(field.get("required")) and not value.strip():
        return False
    config = _mapping(field.get("config"), "field settings")
    kind = _string(config.get("kind"))
    if kind in {"text", "long-text"}:
        return isinstance(value, str) and _within_length(value, config)
    if kind == "email":
        return (
            isinstance(value, str)
            and _within_length(value, config)
            and (not value or re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value) is not None)
        )
    if kind == "url":
        if not isinstance(value, str) or not _within_length(value, config):
            return False
        parsed = urlparse(value)
        return not value or parsed.scheme in {"http", "https"} and bool(parsed.netloc)
    if kind == "checkbox":
        return isinstance(value, bool)
    if kind == "integer":
        return (
            isinstance(value, int)
            and not isinstance(value, bool)
            and _number_is_valid(value, config)
        )
    if kind == "number":
        return (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and (not isinstance(value, float) or isfinite(value))
            and _number_is_valid(value, config)
        )
    if kind == "select":
        options = config.get("options")
        return isinstance(value, str) and isinstance(options, list) and value in options
    if kind == "date":
        return isinstance(value, str) and _date_is_valid(value, config, is_datetime=False)
    if kind == "datetime":
        return isinstance(value, str) and _date_is_valid(value, config, is_datetime=True)
    return False


def _within_length(value: str, config: Mapping[str, object]) -> bool:
    maximum = config.get("maxLength")
    return not isinstance(maximum, int) or len(value) <= maximum


def _number_is_valid(value: int | float, config: Mapping[str, object]) -> bool:
    minimum = config.get("min")
    maximum = config.get("max")
    step = config.get("step")
    if isinstance(minimum, (int, float)) and not isinstance(minimum, bool) and value < minimum:
        return False
    if isinstance(maximum, (int, float)) and not isinstance(maximum, bool) and value > maximum:
        return False
    if isinstance(step, (int, float)) and not isinstance(step, bool):
        if step <= 0:
            return False
        origin = (
            minimum if isinstance(minimum, (int, float)) and not isinstance(minimum, bool) else 0
        )
        return numeric_matches_step(value, origin, step)
    return True


def _date_is_valid(value: str, config: Mapping[str, object], *, is_datetime: bool) -> bool:
    try:
        if is_datetime:
            datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
        else:
            datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    earliest = config.get("earliest")
    latest = config.get("latest")
    return (not isinstance(earliest, str) or value >= earliest) and (
        not isinstance(latest, str) or value <= latest
    )


def _apply_automations(
    *,
    document: SandboxDocument,
    module_id: str,
    module: Mapping[str, object],
    values: dict[str, TestValue],
    event: Mapping[str, object],
    automation_ids: Sequence[str] | None,
    issues: list[SandboxTestIssue],
) -> list[SandboxTestAutomationTrace]:
    automations = [
        cast(Mapping[str, object], item.model_dump(by_alias=True, mode="json"))
        for item in document.automations
    ]
    by_id: dict[str, Mapping[str, object]] = {}
    for automation in automations:
        automation_id = _string(automation.get("id"))
        if automation_id is not None:
            by_id[automation_id] = automation
    selected = selected_automations(by_id, automation_ids, issues)
    traces: list[SandboxTestAutomationTrace] = []
    fields = _fields(module)
    budget = 100
    event_values = dict(values)
    for depth in range(11):
        previous = dict(values)
        for automation in sorted(selected, key=lambda item: cast(int, item["priority"])):
            automation_id = _string(automation.get("id"))
            label = _string(automation.get("name"))
            if automation_id is None or label is None:
                continue
            if not _boolean(automation.get("enabled")):
                if automation_ids is not None and depth == 0:
                    traces.append(
                        SandboxTestAutomationTrace(automation_id, label, "Skipped — disabled")
                    )
                continue
            if not _trigger_matches(automation.get("trigger"), module_id, event_values, event):
                if depth == 0:
                    traces.append(SandboxTestAutomationTrace(automation_id, label, "Not triggered"))
                continue
            conditions_ok = _conditions_match(automation, module_id, fields, values, issues)
            if conditions_ok is None:
                traces.append(SandboxTestAutomationTrace(automation_id, label, "Needs attention"))
                continue
            if not conditions_ok:
                traces.append(
                    SandboxTestAutomationTrace(automation_id, label, "Conditions not met")
                )
                continue
            applied, supported = _apply_actions(
                automation, module_id, fields, values, issues, action_budget=budget
            )
            budget -= applied
            if applied:
                traces.append(SandboxTestAutomationTrace(automation_id, label, "Applied"))
            elif not supported:
                traces.append(SandboxTestAutomationTrace(automation_id, label, "Needs attention"))
            else:
                traces.append(SandboxTestAutomationTrace(automation_id, label, "No changes"))
            if budget == 0:
                issues.append(
                    SandboxTestIssue(
                        "automation_budget_exhausted",
                        "Automation test stopped after 100 field changes.",
                    )
                )
                return traces
        changed_values = {
            field_id: previous.get(field_id, MISSING)
            for field_id in values
            if previous.get(field_id, MISSING) != values[field_id]
        }
        if not changed_values or depth == 10:
            break
        event = {
            "kind": "field-changed",
            "fieldIds": tuple(changed_values),
            "previousValues": changed_values,
        }
        event_values = dict(values)
    return traces


def _trigger_matches(
    raw_trigger: object,
    module_id: str,
    event_values: Mapping[str, TestValue],
    event: Mapping[str, object],
) -> bool:
    trigger = _mapping(raw_trigger, "automation trigger")
    kind = _string(trigger.get("kind"))
    if kind is None or trigger.get("moduleId") != module_id:
        return False
    event_kind = event.get("kind")
    if kind == "threshold-crossed":
        if event_kind not in {"field-changed", "threshold-crossed"}:
            return False
    elif kind != event_kind:
        return False
    if kind == "record-created":
        return True
    if kind == "field-changed":
        field_ids = event.get("fieldIds")
        return event.get("fieldId") == trigger.get("fieldId") or (
            isinstance(field_ids, Sequence) and trigger.get("fieldId") in field_ids
        )
    if kind == "schedule":
        return (
            event.get("frequency") == trigger.get("frequency")
            and event.get("time") == trigger.get("time")
            and (trigger.get("weekday") is None or event.get("weekday") == trigger.get("weekday"))
        )
    if kind == "threshold-crossed":
        field_id = _string(trigger.get("fieldId"))
        field_ids = event.get("fieldIds")
        if (
            event.get("fieldId") != trigger.get("fieldId")
            and (not isinstance(field_ids, Sequence) or trigger.get("fieldId") not in field_ids)
        ) or (
            "previousValue" not in event and not isinstance(event.get("previousValues"), Mapping)
        ):
            return False
        operator = _string(trigger.get("operator"))
        threshold = automation_value(trigger.get("value"), module_id, event_values)
        if field_id is None or operator is None or threshold is UNRESOLVED:
            return False
        current = event_values.get(field_id, MISSING)
        previous_values = event.get("previousValues")
        previous = (
            previous_values.get(field_id, MISSING)
            if isinstance(previous_values, Mapping) and field_id is not None
            else event.get("previousValue")
        )
        return compare(current, operator, threshold) and not compare(previous, operator, threshold)
    return False


def _conditions_match(
    automation: Mapping[str, object],
    module_id: str,
    fields: Mapping[str, Mapping[str, object]],
    values: Mapping[str, TestValue],
    issues: list[SandboxTestIssue],
) -> bool | None:
    automation_id = _string(automation.get("id"))
    group = _mapping(automation.get("conditionGroup"), "automation conditions")
    mode = _string(group.get("operator"))
    raw_conditions = group.get("conditions")
    if mode not in {"all", "any"} or not isinstance(raw_conditions, list):
        automation_issue(issues, automation_id, "Automation conditions need attention.")
        return None
    matched: list[bool] = []
    for raw_condition in raw_conditions:
        condition = _mapping(raw_condition, "automation condition")
        field = _mapping(condition.get("field"), "automation condition field")
        if field.get("moduleId") != module_id or field.get("relationshipId") is not None:
            automation_issue(
                issues, automation_id, "Automation conditions must use the selected module."
            )
            return None
        field_id = _string(field.get("fieldId"))
        operator = _string(condition.get("operator"))
        right = automation_value(condition.get("value"), module_id, values)
        if field_id is None or field_id not in fields or operator is None or right is UNRESOLVED:
            automation_issue(
                issues, automation_id, "Automation conditions refer to an unavailable field."
            )
            return None
        matched.append(compare(values.get(field_id, MISSING), operator, right))
    return all(matched) if mode == "all" else any(matched)


def _apply_actions(
    automation: Mapping[str, object],
    module_id: str,
    fields: Mapping[str, Mapping[str, object]],
    values: dict[str, TestValue],
    issues: list[SandboxTestIssue],
    *,
    action_budget: int,
) -> tuple[int, bool]:
    automation_id = _string(automation.get("id"))
    raw_actions = automation.get("actions")
    if not isinstance(raw_actions, list):
        automation_issue(issues, automation_id, "Automation actions need attention.")
        return False, False
    changed = 0
    supported = True
    for raw_action in raw_actions:
        if changed >= action_budget:
            break
        action = _mapping(raw_action, "automation action")
        if action.get("kind") != "set-field":
            automation_issue(
                issues, automation_id, "This automation action is not supported in tests."
            )
            supported = False
            continue
        target = _mapping(action.get("target"), "automation action target")
        field_id = _string(target.get("fieldId"))
        if (
            target.get("moduleId") != module_id
            or target.get("relationshipId") is not None
            or field_id is None
            or field_id not in fields
        ):
            automation_issue(
                issues, automation_id, "Set field actions must target the selected module."
            )
            supported = False
            continue
        value = automation_value(action.get("value"), module_id, values)
        if value is UNRESOLVED:
            automation_issue(issues, automation_id, "A set field action has an invalid value.")
            supported = False
            continue
        if value is MISSING:
            continue
        candidate = cast(TestValue, value)
        if not _value_is_valid(candidate, fields[field_id]):
            automation_issue(issues, automation_id, "A set field action has an invalid value.")
            supported = False
            continue
        if field_id not in values or values[field_id] != candidate:
            values[field_id] = candidate
            changed += 1
    return changed, supported
