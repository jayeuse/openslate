"""Parity checks for chained temporary Sandbox automation evaluation."""

from app.systems.sandbox.test_runs.evaluator import evaluate_test
from tests.sandbox_test_runs.fixtures import document_payload, sandbox_document


def test_field_change_event_runs_matching_threshold_automation() -> None:
    payload = document_payload()
    automation = payload["automations"][0]
    assert isinstance(automation, dict)
    automation["id"] = "threshold"
    automation["trigger"] = {
        "kind": "threshold-crossed",
        "moduleId": "requests",
        "fieldId": "score",
        "operator": ">=",
        "value": {"kind": "literal", "value": 5},
    }
    automation["conditionGroup"] = {"operator": "all", "conditions": []}
    document = type(sandbox_document()).model_validate(payload)

    result = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "Low", "score": 5},
        event={"kind": "field-changed", "fieldId": "score", "previousValue": 4},
        automation_ids=None,
    )

    assert result.automation_traces[0].outcome == "Applied"


def test_automation_changes_enqueue_a_bounded_follow_up_field_event() -> None:
    payload = document_payload()
    chained = payload["automations"][1]
    assert isinstance(chained, dict)
    chained["trigger"] = {
        "kind": "field-changed",
        "moduleId": "requests",
        "fieldId": "status",
    }
    document = type(sandbox_document()).model_validate(payload)

    result = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "High", "status": "", "score": 0},
        event={"kind": "record-created"},
        automation_ids=None,
    )

    assert result.values["score"] == 10
    assert [trace.outcome for trace in result.automation_traces] == [
        "Applied",
        "Not triggered",
        "Applied",
    ]


def test_equal_priority_automations_preserve_designer_order() -> None:
    payload = document_payload()
    first = payload["automations"][0]
    second = payload["automations"][1]
    assert isinstance(first, dict) and isinstance(second, dict)
    first.update(
        {
            "id": "z-first",
            "priority": 0,
            "conditionGroup": {"operator": "all", "conditions": []},
            "actions": [
                {
                    "id": "first-status",
                    "kind": "set-field",
                    "target": {"moduleId": "requests", "fieldId": "status"},
                    "value": {"kind": "literal", "value": "First"},
                }
            ],
        }
    )
    second.update(
        {
            "id": "a-second",
            "priority": 0,
            "trigger": {"kind": "record-created", "moduleId": "requests"},
            "conditionGroup": {"operator": "all", "conditions": []},
            "actions": [
                {
                    "id": "second-status",
                    "kind": "set-field",
                    "target": {"moduleId": "requests", "fieldId": "status"},
                    "value": {"kind": "literal", "value": "Second"},
                }
            ],
        }
    )
    document = type(sandbox_document()).model_validate(payload)

    result = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "High", "status": "", "score": 0},
        event={"kind": "record-created"},
        automation_ids=None,
    )

    assert result.values["status"] == "Second"


def test_chained_thresholds_use_the_child_event_snapshot_not_prior_actions() -> None:
    payload = document_payload()
    payload["automations"] = [
        {
            "id": "create-score",
            "name": "Create score",
            "enabled": True,
            "priority": 0,
            "trigger": {"kind": "record-created", "moduleId": "requests"},
            "conditionGroup": {"operator": "all", "conditions": []},
            "actions": [
                {
                    "id": "set-five",
                    "kind": "set-field",
                    "target": {"moduleId": "requests", "fieldId": "score"},
                    "value": {"kind": "literal", "value": 5},
                }
            ],
        },
        {
            "id": "raise-score",
            "name": "Raise score",
            "enabled": True,
            "priority": 0,
            "trigger": {"kind": "field-changed", "moduleId": "requests", "fieldId": "score"},
            "conditionGroup": {"operator": "all", "conditions": []},
            "actions": [
                {
                    "id": "set-ten",
                    "kind": "set-field",
                    "target": {"moduleId": "requests", "fieldId": "score"},
                    "value": {"kind": "literal", "value": 10},
                }
            ],
        },
        {
            "id": "detect-five",
            "name": "Detect five",
            "enabled": True,
            "priority": 1,
            "trigger": {
                "kind": "threshold-crossed",
                "moduleId": "requests",
                "fieldId": "score",
                "operator": "=",
                "value": {"kind": "literal", "value": 5},
            },
            "conditionGroup": {"operator": "all", "conditions": []},
            "actions": [
                {
                    "id": "mark-detected",
                    "kind": "set-field",
                    "target": {"moduleId": "requests", "fieldId": "status"},
                    "value": {"kind": "literal", "value": "Detected"},
                }
            ],
        },
    ]
    document = type(sandbox_document()).model_validate(payload)

    result = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "Low", "score": 4, "status": ""},
        event={"kind": "record-created"},
        automation_ids=None,
    )

    assert result.values == {"priority": "Low", "score": 10, "status": "Detected"}


def test_field_references_keep_missing_distinct_from_explicit_null() -> None:
    payload = document_payload()
    automation = payload["automations"][0]
    assert isinstance(automation, dict)
    automation["conditionGroup"] = {"operator": "all", "conditions": []}
    automation["actions"] = [
        {
            "id": "copy-score",
            "kind": "set-field",
            "target": {"moduleId": "requests", "fieldId": "status"},
            "value": {"kind": "field-reference", "moduleId": "requests", "fieldId": "score"},
        }
    ]
    document = type(sandbox_document()).model_validate(payload)

    missing = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "Low", "status": "Original"},
        event={"kind": "record-created"},
        automation_ids=["mark-high"],
    )
    explicit_null = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "Low", "score": None, "status": "Original"},
        event={"kind": "record-created"},
        automation_ids=["mark-high"],
    )

    assert missing.values["status"] == "Original"
    assert explicit_null.values["status"] is None


def test_conditions_keep_missing_distinct_from_explicit_null() -> None:
    payload = document_payload()
    automation = payload["automations"][0]
    assert isinstance(automation, dict)
    automation["conditionGroup"] = {
        "operator": "all",
        "conditions": [
            {
                "id": "score-is-null",
                "field": {"moduleId": "requests", "fieldId": "score"},
                "operator": "=",
                "value": {"kind": "literal", "value": None},
            }
        ],
    }
    automation["actions"][0]["value"] = {"kind": "literal", "value": "Matched"}
    document = type(sandbox_document()).model_validate(payload)

    missing = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "Low", "status": "Original"},
        event={"kind": "record-created"},
        automation_ids=["mark-high"],
    )
    explicit_null = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "Low", "score": None, "status": "Original"},
        event={"kind": "record-created"},
        automation_ids=["mark-high"],
    )

    assert missing.values["status"] == "Original"
    assert explicit_null.values["status"] == "Matched"


def test_absent_target_set_to_null_queues_a_downstream_field_change() -> None:
    payload = document_payload()
    first = payload["automations"][0]
    second = payload["automations"][1]
    assert isinstance(first, dict) and isinstance(second, dict)
    first.update(
        {
            "id": "set-null",
            "trigger": {"kind": "record-created", "moduleId": "requests"},
            "conditionGroup": {"operator": "all", "conditions": []},
            "actions": [
                {
                    "id": "clear-status",
                    "kind": "set-field",
                    "target": {"moduleId": "requests", "fieldId": "status"},
                    "value": {"kind": "literal", "value": None},
                }
            ],
        }
    )
    second.update(
        {
            "id": "observe-null",
            "trigger": {"kind": "field-changed", "moduleId": "requests", "fieldId": "status"},
            "conditionGroup": {"operator": "all", "conditions": []},
            "actions": [
                {
                    "id": "set-score",
                    "kind": "set-field",
                    "target": {"moduleId": "requests", "fieldId": "score"},
                    "value": {"kind": "literal", "value": 10},
                }
            ],
        }
    )
    document = type(sandbox_document()).model_validate(payload)

    result = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "Low", "score": 0},
        event={"kind": "record-created"},
        automation_ids=None,
    )

    assert result.values["status"] is None
    assert result.values["score"] == 10


def test_test_evaluation_stops_after_the_shared_hundred_action_budget() -> None:
    payload = document_payload()
    modules = payload["design"]["modules"]
    assert isinstance(modules, list) and isinstance(modules[0], dict)
    module = modules[0]
    fields = module["fields"]
    assert isinstance(fields, list)
    for index in range(101):
        fields.append(
            {
                "id": f"budget-{index}",
                "name": f"Budget {index}",
                "type": "Text",
                "config": {"kind": "text", "defaultValue": ""},
            }
        )
    payload["automations"] = [
        {
            "id": f"budget-automation-{index}",
            "name": f"Budget automation {index}",
            "enabled": True,
            "priority": index,
            "trigger": {"kind": "record-created", "moduleId": "requests"},
            "conditionGroup": {"operator": "all", "conditions": []},
            "actions": [
                {
                    "id": f"budget-action-{index}",
                    "kind": "set-field",
                    "target": {"moduleId": "requests", "fieldId": f"budget-{index}"},
                    "value": {"kind": "literal", "value": "Applied"},
                }
            ],
        }
        for index in range(101)
    ]
    document = type(sandbox_document()).model_validate(payload)

    result = evaluate_test(
        document=document,
        module_id="requests",
        values={"priority": "Low"},
        event={"kind": "record-created"},
        automation_ids=None,
    )

    assert result.values["budget-99"] == "Applied"
    assert "budget-100" not in result.values
    assert [issue.code for issue in result.issues] == ["automation_budget_exhausted"]
