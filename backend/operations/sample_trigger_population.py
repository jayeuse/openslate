"""Exercise published record automations through record APIs and readback."""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from typing import Any
from uuid import UUID

from operations.sample_blueprint import SampleDataset, SampleRecord
from operations.sample_client import SampleClient
from operations.sample_population import SamplePopulationError, _api, _api_id
from operations.sample_verification import SampleVerificationError, list_all_rows

_RECORD_CREATED = ("order-created-confirmation", "urgent-request-created")
_PATCH_TRIGGERS = (
    "quote-value-changed",
    "work-order-state-changed",
    "large-invoice-threshold",
    "large-movement-threshold",
)
_SCHEDULE_TRIGGERS = ("daily-stock-review", "weekly-maintenance-review")


def validate_record_trigger_candidates(dataset: SampleDataset) -> None:
    """Ensure generated records exercise both enabled record-created rules."""
    for key in _RECORD_CREATED:
        trigger = _trigger_by_key(dataset, key)
        candidates = _candidate_records(dataset, trigger)
        if not candidates:
            raise SamplePopulationError(f"No authored record exercises trigger {key}")
    for key in _PATCH_TRIGGERS:
        _trigger_mutation(dataset, key)


def exercise_record_triggers(
    admin: SampleClient,
    dataset: SampleDataset,
    records: Mapping[str, Mapping[str, Any]],
    modules: Mapping[str, Mapping[str, Any]],
    field_ids: Mapping[str, str],
    actor_ids: Mapping[str, str],
    clients: Mapping[str, SampleClient],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Wait for real actions and prove their values through the records API."""
    evidence: list[dict[str, Any]] = []
    mutations: list[dict[str, Any]] = []
    for key in _RECORD_CREATED:
        trigger = _trigger_by_key(dataset, key)
        candidates = _candidate_records(dataset, trigger)
        evidence.append(
            _wait_trigger(
                admin,
                key,
                trigger,
                target_logical_ids=[item.logical_id for item in candidates],
                target_field_id=_field_api_id(
                    dataset, trigger, _trigger_action_field(trigger), field_ids
                ),
                expected_value=_trigger_action_value(trigger),
                records=records,
                timeout=180,
            )
        )

    for key in _PATCH_TRIGGERS:
        trigger = _trigger_by_key(dataset, key)
        logical_id, changed_doc_field, changed_value = _trigger_mutation(dataset, key)
        sample = next((item for item in dataset.records if item.logical_id == logical_id), None)
        if sample is None:
            raise SamplePopulationError(f"No record is available for trigger {key}")
        module_id = str(modules[sample.module_key].get("id"))
        record_id = _api_id(records[logical_id], "record ID")
        actor = clients[sample.creator_key]
        current = _api(actor, "GET", f"/api/records/{record_id}")
        data = current.get("data")
        if current.get("module_id") != module_id or not isinstance(data, dict):
            raise SamplePopulationError(f"Record readback failed before trigger {key}")
        changed_field_id = _field_api_id(
            dataset, trigger, changed_doc_field, field_ids, module_key=sample.module_key
        )
        if data.get(changed_field_id) == changed_value:
            raise SamplePopulationError(f"Trigger {key} input would not change the record")
        action_field_id = _field_api_id(
            dataset,
            trigger,
            _trigger_action_field(trigger),
            field_ids,
            module_key=sample.module_key,
        )
        action_value = _trigger_action_value(trigger)
        action_reset = None
        if data.get(action_field_id) == action_value:
            if action_value is not True:
                raise SamplePopulationError(f"Trigger {key} action would not change the record")
            data[action_field_id] = False
            action_reset = {"field_id": action_field_id, "value": False}
        data[changed_field_id] = changed_value
        path = f"/api/records/{record_id}"
        response = actor.request("PATCH", path, json_body={"data": data})
        if response.status_code != 200:
            raise SamplePopulationError(f"PATCH {path} returned HTTP {response.status_code}")
        updated = _response_object(response, "Record update")
        request_id = response.headers.get("X-Request-ID")
        try:
            request_id = str(UUID(request_id))
        except (TypeError, ValueError):
            raise SamplePopulationError("Trigger mutation request context is incomplete") from None
        actor_id = actor_ids.get(sample.creator_key)
        if not request_id or not actor_id:
            raise SamplePopulationError("Trigger mutation audit context is incomplete")
        mutations.append(
            {
                "trigger_key": key,
                "record_logical_id": logical_id,
                "record_id": record_id,
                "actor_id": actor_id,
                "request_id": request_id,
                "request_method": "PATCH",
                "request_path": path,
                "changed_field_id": changed_field_id,
                "changed_value": changed_value,
                "action_reset": action_reset,
            }
        )
        evidence.append(
            _wait_trigger(
                admin,
                key,
                trigger,
                target_logical_ids=[logical_id],
                target_field_id=action_field_id,
                expected_value=action_value,
                records={**records, logical_id: {**updated, "module_key": sample.module_key}},
                timeout=180,
            )
        )
    for key in _SCHEDULE_TRIGGERS:
        trigger = _trigger_by_key(dataset, key)
        if trigger.get("enabled") is not False:
            raise SamplePopulationError("Scheduled sample automations must finish disabled")
        evidence.append(
            {"trigger_key": key, "name": trigger.get("name"), "enabled": False, "run_ids": []}
        )
    return evidence, mutations


def _wait_trigger(
    admin: SampleClient,
    key: str,
    trigger: Mapping[str, Any],
    *,
    target_logical_ids: Sequence[str],
    target_field_id: str,
    expected_value: Any,
    records: Mapping[str, Mapping[str, Any]],
    timeout: float,
) -> dict[str, Any]:
    name = trigger.get("name")
    if not isinstance(name, str) or not target_field_id:
        raise SamplePopulationError("Trigger readback mapping is incomplete")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            runs = list_all_rows(admin, "/api/sandbox/trigger-runs", page_size=50)
        except SampleVerificationError as error:
            if not _changed_run_snapshot(error) or time.monotonic() >= deadline:
                raise
            time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
            continue
        matching = [
            row
            for row in runs
            if row.get("triggerName") == name
            and row.get("state") == "succeeded"
            and isinstance(row.get("details"), Mapping)
            and isinstance(row["details"].get("actionsApplied"), int)
            and row["details"]["actionsApplied"] > 0
        ]
        if matching:
            for logical_id in target_logical_ids:
                record = records.get(logical_id)
                if record is None:
                    continue
                current = _api(admin, "GET", f"/api/records/{_api_id(record, 'record ID')}")
                data = current.get("data")
                if isinstance(data, Mapping) and data.get(target_field_id) == expected_value:
                    # Journal the evidence once: new runs can arrive between polls.
                    for index, run in enumerate(matching, start=1):
                        admin.record_mapping(
                            "trigger_runs", f"{key.replace('-', '_')}:{index:04d}", _api_id(run)
                        )
                    return {
                        "trigger_key": key,
                        "name": name,
                        "enabled": True,
                        "run_ids": [_api_id(run, "trigger run ID") for run in matching],
                        "successful_runs": len(matching),
                        "actions_applied": sum(
                            int(run["details"]["actionsApplied"]) for run in matching
                        ),
                        "target_logical_id": logical_id,
                        "target_field_id": target_field_id,
                        "expected_value": expected_value,
                    }
        time.sleep(min(1.0, max(0.0, deadline - time.monotonic())))
    raise SamplePopulationError(f"Trigger {key} did not produce its expected API result in time")


def _changed_run_snapshot(error: SampleVerificationError) -> bool:
    return str(error) in {
        "GET /api/sandbox/trigger-runs changed while pages were being read",
        "GET /api/sandbox/trigger-runs returned inconsistent pagination metadata",
    }


def _trigger_mutation(dataset: SampleDataset, key: str) -> tuple[str, str, Any]:
    if key == "quote-value-changed":
        sample = next(item for item in dataset.records if item.logical_id == "quotes:000001")
        field_id = dataset.field_ids["quotes"]["total"]
        current = sample.data.get(field_id, 0)
        if isinstance(current, bool) or not isinstance(current, (int, float)):
            raise SamplePopulationError("Quote trigger input is not numeric")
        return sample.logical_id, field_id, max(current + 1, 5_001)
    if key == "work-order-state-changed":
        sample = next(item for item in dataset.records if item.logical_id == "work_orders:000001")
        field_id = dataset.field_ids["work_orders"]["status"]
        current = sample.data.get(field_id)
        target = _select_option_id(dataset, "work_orders", "status", "Scheduled")
        alternative = _select_option_id(dataset, "work_orders", "status", "Overdue")
        return sample.logical_id, field_id, alternative if current == target else target
    if key == "large-invoice-threshold":
        total_id = dataset.field_ids["invoices"]["total"]
        status_id = dataset.field_ids["invoices"]["status"]
        defaults = _module_defaults(dataset, "invoices")
        cancelled = _select_option_id(dataset, "invoices", "status", "Cancelled")
        paid = _select_option_id(dataset, "invoices", "status", "Paid")
        for sample in dataset.records:
            if sample.module_key != "invoices" or sample.logical_id == "invoices:000001":
                continue
            total = sample.data.get(total_id, defaults.get(total_id))
            status = sample.data.get(status_id, defaults.get(status_id))
            if (
                isinstance(total, (int, float))
                and not isinstance(total, bool)
                and total <= 10_000
                and status not in {cancelled, paid}
            ):
                return sample.logical_id, total_id, 10_001
        raise SamplePopulationError("No non-cancelled open invoice exercises the threshold rule")
    if key == "large-movement-threshold":
        return "stock_movements:000001", dataset.field_ids["stock_movements"]["quantity"], 20
    raise SamplePopulationError("Unknown record trigger mutation")


def _candidate_records(dataset: SampleDataset, trigger: Mapping[str, Any]) -> list[SampleRecord]:
    module_id = _trigger_module_id(trigger)
    module_key = next(
        (key for key, value in dataset.module_ids.items() if value == module_id), None
    )
    if module_key is None:
        raise SamplePopulationError("Record trigger module mapping is incomplete")
    conditions = _trigger_conditions(trigger)
    defaults = _module_defaults(dataset, module_key)
    return [
        record
        for record in dataset.records
        if record.module_key == module_key and _matches_conditions(record, conditions, defaults)
    ]


def _matches_conditions(
    record: SampleRecord,
    conditions: Sequence[Mapping[str, Any]],
    defaults: Mapping[str, Any],
) -> bool:
    values = {**defaults, **record.data}
    results: list[bool] = []
    for condition in conditions:
        field = condition.get("field")
        value = condition.get("value")
        field_id = field.get("fieldId") if isinstance(field, Mapping) else None
        expected = value.get("value") if isinstance(value, Mapping) else None
        if not isinstance(field_id, str) or not isinstance(value, Mapping):
            return False
        actual = values.get(field_id)
        results.append(_compare_values(actual, expected, condition.get("operator")))
    return all(results) if conditions and conditions[0].get("_operator") == "all" else any(results)


def _compare_values(actual: Any, expected: Any, operator: object) -> bool:
    try:
        if operator == "=":
            return bool(actual == expected)
        if operator == "!=":
            return bool(actual != expected)
        if operator == ">":
            return bool(actual > expected)
        if operator == ">=":
            return bool(actual >= expected)
        if operator == "<":
            return bool(actual < expected)
        if operator == "<=":
            return bool(actual <= expected)
    except TypeError:
        return False
    return False


def _trigger_conditions(trigger: Mapping[str, Any]) -> list[dict[str, Any]]:
    group = trigger.get("conditionGroup")
    conditions = group.get("conditions") if isinstance(group, Mapping) else None
    operator = group.get("operator") if isinstance(group, Mapping) else None
    if not isinstance(conditions, list) or operator not in {"all", "any"}:
        raise SamplePopulationError("Generated trigger condition group is invalid")
    return [{**item, "_operator": operator} for item in conditions if isinstance(item, dict)]


def _module_defaults(dataset: SampleDataset, module_key: str) -> dict[str, Any]:
    design = dataset.document.get("design")
    modules = design.get("modules") if isinstance(design, Mapping) else None
    module = (
        next(
            (
                item
                for item in modules
                if isinstance(item, Mapping) and item.get("id") == dataset.module_ids[module_key]
            ),
            None,
        )
        if isinstance(modules, list)
        else None
    )
    fields = module.get("fields") if isinstance(module, Mapping) else None
    module_fields = fields if isinstance(fields, list) else []
    return {
        str(field["id"]): field["config"]["defaultValue"]
        for field in module_fields
        if isinstance(field, Mapping)
        and isinstance(field.get("id"), str)
        and isinstance(field.get("config"), Mapping)
        and "defaultValue" in field["config"]
    }


def _trigger_by_key(dataset: SampleDataset, key: str) -> Mapping[str, Any]:
    triggers = dataset.document.get("triggers")
    trigger_id = dataset.trigger_ids.get(key)
    if not isinstance(triggers, list) or trigger_id is None:
        raise SamplePopulationError("Generated trigger definition is missing")
    matches = [
        item for item in triggers if isinstance(item, Mapping) and item.get("id") == trigger_id
    ]
    if len(matches) != 1:
        raise SamplePopulationError("Generated trigger definition is ambiguous")
    return matches[0]


def _trigger_module_id(trigger: Mapping[str, Any]) -> str:
    event = trigger.get("trigger")
    module_id = event.get("moduleId") if isinstance(event, Mapping) else None
    if not isinstance(module_id, str):
        raise SamplePopulationError("Generated trigger module is missing")
    return module_id


def _trigger_action_field(trigger: Mapping[str, Any]) -> str:
    actions = trigger.get("actions")
    target = (
        actions[0].get("target")
        if isinstance(actions, list) and actions and isinstance(actions[0], Mapping)
        else None
    )
    field_id = target.get("fieldId") if isinstance(target, Mapping) else None
    if not isinstance(field_id, str):
        raise SamplePopulationError("Generated trigger action field is missing")
    return field_id


def _trigger_action_value(trigger: Mapping[str, Any]) -> Any:
    actions = trigger.get("actions")
    value = (
        actions[0].get("value")
        if isinstance(actions, list) and actions and isinstance(actions[0], Mapping)
        else None
    )
    if not isinstance(value, Mapping) or value.get("kind") != "literal":
        raise SamplePopulationError("Generated trigger action is not a literal Set-field action")
    return value.get("value")


def _field_api_id(
    dataset: SampleDataset,
    trigger: Mapping[str, Any],
    document_field_id: str,
    field_ids: Mapping[str, str],
    *,
    module_key: str | None = None,
) -> str:
    module_key = module_key or next(
        (key for key, value in dataset.module_ids.items() if value == _trigger_module_id(trigger)),
        None,
    )
    field_key = next(
        (
            key
            for key, value in dataset.field_ids.get(module_key or "", {}).items()
            if value == document_field_id
        ),
        None,
    )
    api_id = field_ids.get(f"{module_key}:{field_key}") if module_key and field_key else None
    if not api_id:
        raise SamplePopulationError("Published trigger field mapping is incomplete")
    return api_id


def _select_option_id(dataset: SampleDataset, module_key: str, field_key: str, label: str) -> str:
    document_id = dataset.field_ids[module_key][field_key]
    design = dataset.document.get("design")
    modules = design.get("modules") if isinstance(design, Mapping) else None
    if not isinstance(modules, list):
        raise SamplePopulationError("Published select field module is missing")
    module = next(
        (
            item
            for item in modules
            if isinstance(item, Mapping) and item.get("id") == dataset.module_ids[module_key]
        ),
        None,
    )
    if not isinstance(module, Mapping):
        raise SamplePopulationError("Published select field module is missing")
    fields = module.get("fields")
    if not isinstance(fields, list):
        raise SamplePopulationError("Published select field metadata is missing")
    field = next(
        (item for item in fields if isinstance(item, Mapping) and item.get("id") == document_id),
        None,
    )
    if not isinstance(field, Mapping):
        raise SamplePopulationError("Published select field metadata is missing")
    config = field.get("config")
    options = config.get("options") if isinstance(config, Mapping) else None
    option = (
        next(
            (item for item in options if isinstance(item, Mapping) and item.get("label") == label),
            None,
        )
        if isinstance(options, list)
        else None
    )
    option_id = option.get("id") if isinstance(option, Mapping) else None
    if not isinstance(option_id, str):
        raise SamplePopulationError("A required trigger status option is missing")
    return option_id


def _response_object(response: Any, label: str) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError:
        raise SamplePopulationError(f"{label} returned invalid JSON") from None
    if not isinstance(payload, dict):
        raise SamplePopulationError(f"{label} returned an invalid object")
    return payload
