"""Core temporary-value evaluator checks."""

from __future__ import annotations

from copy import deepcopy

import pytest

from app.systems.sandbox.test_runs.evaluator import (
    _date_is_valid,
    _departments,
    _fields,
    _mapping,
    _modules,
    _number_is_valid,
    _value_is_valid,
    evaluate_test,
)
from tests.sandbox_test_runs.fixtures import document_payload, sandbox_document


def test_enabled_triggers_apply_in_priority_order_without_mutating_document() -> None:
    document = sandbox_document()
    original = deepcopy(document.model_dump(by_alias=True, mode="json"))
    result = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "High", "status": "", "score": 0},
        event={"kind": "record-created"},
        trigger_ids=None,
    )
    assert document.model_dump(by_alias=True, mode="json") == original
    assert result.values == {"priority": "High", "status": "Triaged", "score": 10}
    assert [trace.trigger_id for trace in result.trigger_traces] == [
        "mark-high",
        "copy-triaged",
    ]


def test_threshold_requires_a_crossing_from_previous_to_current_value() -> None:
    payload = document_payload()
    record_trigger = payload["triggers"][0]
    assert isinstance(record_trigger, dict)
    record_trigger["id"] = "threshold"
    record_trigger["trigger"] = {
        "kind": "threshold-crossed",
        "moduleId": "requests",
        "fieldId": "score",
        "operator": ">=",
        "value": {"kind": "literal", "value": 5},
    }
    record_trigger["conditionGroup"] = {"operator": "all", "conditions": []}
    document = type(sandbox_document()).model_validate(payload)
    crossed = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "Low", "score": 5},
        event={"kind": "threshold-crossed", "fieldId": "score", "previousValue": 4},
        trigger_ids=None,
    )
    already_met = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "Low", "score": 6},
        event={"kind": "threshold-crossed", "fieldId": "score", "previousValue": 5},
        trigger_ids=None,
    )
    assert crossed.trigger_traces[0].outcome == "Applied"
    assert already_met.trigger_traces[0].outcome == "Not triggered"


def test_datetime_thresholds_compare_temporary_values_as_instants() -> None:
    payload = document_payload()
    design = payload["design"]
    assert isinstance(design, dict)
    modules = design["modules"]
    assert isinstance(modules, list)
    requests = modules[0]
    assert isinstance(requests, dict)
    fields = requests["fields"]
    assert isinstance(fields, list)
    fields.append(
        {
            "id": "due-at",
            "name": "Due at",
            "type": "Date/Time",
            "required": False,
            "closed": False,
            "config": {"kind": "datetime", "defaultValue": None},
        }
    )
    record_trigger = payload["triggers"][0]
    assert isinstance(record_trigger, dict)
    record_trigger["trigger"] = {
        "kind": "threshold-crossed",
        "moduleId": "requests",
        "fieldId": "due-at",
        "operator": ">=",
        "value": {"kind": "literal", "value": "2025-01-01T00:00:00Z"},
    }
    record_trigger["conditionGroup"] = {"operator": "all", "conditions": []}
    payload["triggers"] = [record_trigger]
    document = type(sandbox_document()).model_validate(payload)

    result = evaluate_test(
        document=document,
        module_id="requests",
        values={
            "priority": "Low",
            "status": "",
            "due-at": "2025-01-01T01:00:00+02:00",
        },
        event={
            "kind": "threshold-crossed",
            "fieldId": "due-at",
            "previousValue": "2024-12-31T22:00:00Z",
        },
        trigger_ids=None,
    )

    assert result.trigger_traces[0].outcome == "Not triggered"


def test_invalid_values_stop_trigger_but_keep_a_safe_relationship_route() -> None:
    result = evaluate_test(
        document=sandbox_document(),
        module_id="requests",
        values={"priority": "Unknown", "missing": "value"},
        event={"kind": "record-created"},
        trigger_ids=None,
    )
    assert result.values == {}
    assert result.trigger_traces == ()
    assert {issue.code for issue in result.issues} == {
        "field_invalid",
        "value_invalid",
        "value_required",
    }
    assert result.routes[0].label == "Operations / Requests → Service / Equipment"


def test_selected_and_disabled_triggers_are_handled_without_running_disabled_actions() -> None:
    payload = document_payload()
    disabled = payload["triggers"][1]
    assert isinstance(disabled, dict)
    disabled["enabled"] = False
    document = type(sandbox_document()).model_validate(payload)
    all_enabled = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "High", "status": "", "score": 0},
        event={"kind": "record-created"},
        trigger_ids=None,
    )
    explicit = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "High", "status": "", "score": 0},
        event={"kind": "record-created"},
        trigger_ids=["copy-triaged", "mark-high"],
    )
    assert [trace.trigger_id for trace in all_enabled.trigger_traces] == ["mark-high"]
    assert all_enabled.values["score"] == 0
    assert [trace.outcome for trace in explicit.trigger_traces] == [
        "Applied",
        "Skipped — disabled",
    ]


def test_field_change_triggers_match_only_the_selected_field() -> None:
    payload = document_payload()
    record_trigger = payload["triggers"][0]
    assert isinstance(record_trigger, dict)
    record_trigger["trigger"] = {
        "kind": "field-changed",
        "moduleId": "requests",
        "fieldId": "priority",
    }
    record_trigger["conditionGroup"] = {"operator": "all", "conditions": []}
    document = type(sandbox_document()).model_validate(payload)
    changed = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "High", "status": ""},
        event={"kind": "field-changed", "fieldId": "priority"},
        trigger_ids=["mark-high"],
    )
    wrong_field = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "High", "status": ""},
        event={"kind": "field-changed", "fieldId": "status"},
        trigger_ids=["mark-high"],
    )
    assert changed.trigger_traces[0].outcome == "Applied"
    assert wrong_field.trigger_traces[0].outcome == "Not triggered"


def test_relationship_projection_and_unsupported_actions_report_issues() -> None:
    payload = document_payload()
    record_trigger = payload["triggers"][0]
    assert isinstance(record_trigger, dict)
    record_trigger["conditionGroup"] = {"operator": "all", "conditions": []}
    record_trigger["actions"] = [
        {"id": "notify", "kind": "notification", "message": "Legacy"},
        {
            "id": "change-target",
            "kind": "set-field",
            "target": {"moduleId": "equipment", "fieldId": "priority-copy"},
            "value": {"kind": "literal", "value": "High"},
        },
    ]
    document = type(sandbox_document()).model_validate(payload)
    result = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "High", "status": "", "score": 0},
        event={"kind": "record-created"},
        trigger_ids=["mark-high"],
    )
    assert result.trigger_traces[0].outcome == "Needs attention"
    assert [issue.code for issue in result.issues] == ["trigger_invalid", "trigger_invalid"]


def test_huge_integer_survives_validation_and_relationship_projection() -> None:
    payload = document_payload()
    payload["triggers"] = []
    relationship = payload["design"]["relationships"][0]
    relationship["fieldMappings"] = [{"sourceFieldId": "score", "targetFieldId": "priority-copy"}]
    source_field = payload["design"]["modules"][0]["fields"][2]
    source_field["config"]["step"] = 2
    target_field = payload["design"]["modules"][1]["fields"][0]
    target_field.update(
        {
            "name": "Score copy",
            "type": "Number",
            "config": {"kind": "number", "defaultValue": 0, "min": 0, "step": 2},
        }
    )
    document = type(sandbox_document()).model_validate(payload)
    value = 10**500
    result = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "Low", "score": value},
        event={"kind": "record-created"},
        trigger_ids=None,
    )
    assert result.issues == ()
    assert result.values["score"] == value


def test_defensive_value_helpers_cover_every_supported_temporary_input_type() -> None:
    field = lambda kind, **config: {  # noqa: E731
        "required": False,
        "config": {"kind": kind, **config},
    }
    assert _value_is_valid("owner@example.com", field("email", maxLength=40))
    assert not _value_is_valid("bad", field("email"))
    assert _value_is_valid("https://example.com", field("url"))
    assert not _value_is_valid("ftp://example.com", field("url"))
    assert _value_is_valid(True, field("checkbox"))
    assert _value_is_valid(4, field("integer", min=0, max=8, step=2))
    assert _value_is_valid(4.5, field("number"))
    assert _value_is_valid("Open", field("select", options=["Open"]))
    assert _value_is_valid("2026-09-21", field("date"))
    assert _value_is_valid("2026-09-21T09:00:00Z", field("datetime"))
    assert not _value_is_valid("value", field("unknown"))
    assert not _number_is_valid(-1, {"min": 0})
    assert not _number_is_valid(11, {"max": 10})
    assert not _number_is_valid(3, {"min": 0, "step": 2})
    assert _number_is_valid(4, {"min": 0, "step": 2})
    assert _value_is_valid(10**500, field("number", min=0, step=2))
    assert not _value_is_valid(10**500 + 1, field("number", min=0, step=2))
    assert not _date_is_valid("bad", {}, is_datetime=False)
    assert _date_is_valid("2026-09-21T09:00:00Z", {}, is_datetime=True)
    assert not _date_is_valid(
        "2025-01-01T01:00:00+02:00",
        {"earliest": "2025-01-01T00:00:00Z"},
        is_datetime=True,
    )
    assert _date_is_valid(
        "2025-01-01T00:00:00+00:00",
        {
            "earliest": "2025-01-01T00:00:00Z",
            "latest": "2025-01-01T00:00:00Z",
        },
        is_datetime=True,
    )


def test_defensive_document_helpers_reject_non_collection_shapes() -> None:
    with pytest.raises(ValueError, match="Sandbox design is invalid"):
        _mapping("bad", "design")
    with pytest.raises(ValueError, match="Sandbox modules are invalid"):
        _modules({"modules": "bad"})
    assert _departments({"departments": "bad"}) == {}
    assert _fields({"fields": "bad"}) == {}
