"""Pack-neutral OpenView query planning and execution for the coverage phase."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import timedelta
from typing import Any

from operations.sample.blueprint import SampleDataset, SampleEdge, SampleRecord
from operations.sample.controls.openview_snapshots import (
    _wire_references,
    batch_snapshot_action,
    execute_snapshot_control,
)
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.phase_types import PhaseAction, PhaseJsonValue
from operations.sample.packs.types import FieldSpec, ModuleSpec
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _read_json,
    _request,
    _request_id,
    _result,
)
from operations.sample.phases.planning import _manager_key, _openview_source

QUERY_ROUTES = frozenset(
    {
        ("POST", "/api/records/query"),
        ("POST", "/api/records/grouped-query"),
        ("POST", "/api/records/window-query"),
        ("POST", "/api/records/aggregate-query"),
        ("POST", "/api/records/aggregate-snapshot"),
        ("POST", "/api/records/aggregate-snapshots"),
    }
)

_FIELD_TYPES = {
    "Text": "text",
    "Long text": "long_text",
    "Number": "number",
    "Integer": "int",
    "Date": "date",
    "Date/Time": "datetime",
    "Checkbox": "boolean",
    "Select": "select",
    "Email": "email",
    "URL": "url",
    "User": "user",
}
_QUERY_PATHS = {
    "record_query": "/api/records/query",
    "grouped_query": "/api/records/grouped-query",
    "window_query": "/api/records/window-query",
    "aggregate_groups": "/api/records/aggregate-query",
    "aggregate_scalar": "/api/records/aggregate-query",
    "aggregate_date_series": "/api/records/aggregate-query",
    "aggregate_snapshot_groups": "/api/records/aggregate-snapshot",
    "aggregate_snapshot_date_series": "/api/records/aggregate-snapshot",
}


def _modules(pack: OrganizationPack) -> dict[str, ModuleSpec]:
    return {module.key: module for module in pack.catalog.modules}


def _field(module: ModuleSpec, key: str) -> FieldSpec:
    field = next((item for item in module.fields if item.key == key), None)
    if field is None or field.type not in _FIELD_TYPES:
        raise ValueError(f"OpenView control plan needs a supported {key} field in {module.key}")
    return field


def _field_reference(module: ModuleSpec, field: FieldSpec) -> dict[str, PhaseJsonValue]:
    return {
        "field_key": f"{module.key}:{field.key}",
        "expected_type": _FIELD_TYPES[field.type],
    }


def _query_fields(module: ModuleSpec, required: tuple[FieldSpec, ...]) -> list[FieldSpec]:
    selected = list(dict.fromkeys(required))
    selected.extend(field for field in module.fields if field.type in _FIELD_TYPES)
    return list(dict.fromkeys(selected))[:12]


def _definition(module: ModuleSpec, required: tuple[FieldSpec, ...]) -> dict[str, PhaseJsonValue]:
    fields = _query_fields(module, required)
    name = _field(module, "name")
    return {
        "version": 1,
        "columns": [_field_reference(module, field) for field in fields],
        "filters": [],
        "logic": "and",
        "sort": [],
        "deleted": "exclude",
        "search": None,
        "search_fields": [_field_reference(module, name)],
    }


def _date_field(module: ModuleSpec) -> FieldSpec:
    field = next((item for item in module.fields if item.type in {"Date", "Date/Time"}), None)
    if field is None:
        raise ValueError(f"OpenView query module {module.key} has no date field")
    return field


def _scalar_source(pack: OrganizationPack, fallback: ModuleSpec) -> tuple[ModuleSpec, FieldSpec]:
    for module in pack.catalog.modules:
        measure = next(
            (field for field in module.fields if field.type in {"Number", "Integer"}), None
        )
        if measure is not None:
            return module, measure
    measure = next(
        (field for field in fallback.fields if field.type in {"Number", "Integer"}), None
    )
    if measure is None:
        raise ValueError("OpenView control plan needs a numeric measure for aggregate queries")
    return fallback, measure


def select_openview_target(dataset: SampleDataset) -> tuple[str, ModuleSpec, str]:
    """Select an authored view source and a manager who can operate it."""
    pack = dataset.organization
    spec = pack.phases
    if spec is None:
        raise ValueError("OpenView control plan requires pack phase data")
    modules = _modules(pack)
    for department_key in spec.openview_department_candidates:
        if department_key not in pack.actors.department_keys:
            continue
        try:
            module_key = _openview_source(pack, department_key)
        except ValueError:
            continue
        manager = _manager_key(pack, department_key, module_key)
        if manager:
            return department_key, modules[module_key], manager
    raise ValueError("OpenView control plan has no department manager and report source")


def make_control_action(
    operation: str,
    actor_key: str,
    target_key: str,
    values: dict[str, PhaseJsonValue],
    expected_end_state: dict[str, PhaseJsonValue],
) -> PhaseAction:
    return PhaseAction(
        key=f"control:{operation}",
        phase="reorganization",
        kind="openview_controls",
        actor_key=actor_key,
        target_key=target_key,
        values={"operation": operation, **values},
        expected_status=200,
        expected_detail=None,
        expected_end_state=expected_end_state,
    )


def triggered_modules(dataset: SampleDataset) -> set[str]:
    triggers = dataset.document.get("triggers", [])
    if not isinstance(triggers, list):
        raise ValueError("OpenView control plan found invalid authored triggers")
    module_keys = {server_id: key for key, server_id in dataset.module_ids.items()}
    result: set[str] = set()
    for row in triggers:
        if not isinstance(row, Mapping):
            continue
        trigger = row.get("trigger")
        if isinstance(trigger, Mapping) and isinstance(trigger.get("moduleId"), str):
            module_key = module_keys.get(trigger["moduleId"])
            if module_key:
                result.add(module_key)
    return result


def record_templates(dataset: SampleDataset) -> dict[str, SampleRecord]:
    return {record.module_key: record for record in dataset.records}


def control_name(
    dataset: SampleDataset,
    module: ModuleSpec,
    reserved: dict[str, set[str]],
) -> str:
    names = reserved.setdefault(module.key, set())
    name_field_id = dataset.field_ids[module.key].get("name")
    if name_field_id is None:
        raise ValueError(f"OpenView control module {module.key} has no generated Name field")
    existing = {
        str(record.data[name_field_id])
        for record in dataset.records
        if record.module_key == module.key and isinstance(record.data.get(name_field_id), str)
    }
    start = dataset.module_counts[module.key]
    for index in range(start, start + 100):
        name = dataset.organization.text.record_title(
            module.key, index, dataset.seed, dataset.module_counts
        )
        if name not in existing and name not in names:
            names.add(name)
            return name
    # A finite catalog can distinguish a title by an authored business value,
    # such as a class's period or term, rather than by run bookkeeping.
    template = record_templates(dataset)[module.key]
    title = str(template.data[name_field_id])
    for field in module.fields:
        value = template.data.get(dataset.field_ids[module.key][field.key])
        if field.type != "Select" or field.key == "status" or not isinstance(value, str):
            continue
        if not value.strip() or value.casefold() in title.casefold():
            continue
        name = f"{title} — {value}"
        if name not in existing and name not in names:
            names.add(name)
            return name
    raise ValueError(f"OpenView control plan could not choose a unique {module.key} record name")


def control_modules(
    dataset: SampleDataset,
) -> tuple[ModuleSpec, ModuleSpec, ModuleSpec, SampleEdge]:
    modules = _modules(dataset.organization)
    templates = record_templates(dataset)
    triggered = triggered_modules(dataset)
    lifecycle_module = next(
        (
            module
            for module in dataset.organization.catalog.modules
            if module.key not in triggered
            and module.key in templates
            and any(field.key == "name" for field in module.fields)
        ),
        None,
    )
    if lifecycle_module is None:
        raise ValueError("OpenView record lifecycle control needs a trigger-free pack module")
    for relation in dataset.organization.catalog.relationships:
        if relation.cardinality not in {"one-to-many", "many-to-many"}:
            continue
        if relation.source in triggered or relation.target in triggered:
            continue
        edge = next(
            (
                candidate
                for candidate in dataset.edges
                if candidate.relationship_id == dataset.relationship_ids[relation.key]
            ),
            None,
        )
        source, target = templates.get(relation.source), templates.get(relation.target)
        if edge is not None and source is not None and target is not None:
            return lifecycle_module, modules[relation.source], modules[relation.target], edge
    raise ValueError("OpenView relationship control needs a trigger-free authored relationship")


def _query_action(
    operation: str,
    actor_key: str,
    values: dict[str, PhaseJsonValue],
) -> PhaseAction:
    return make_control_action(
        operation,
        actor_key,
        f"control:{operation}",
        values,
        {"query_valid": True},
    )


def plan_openview_query_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    """Build frontend-shaped query controls from module and field pack data."""
    pack = dataset.organization
    _, source, manager = select_openview_target(dataset)
    name = _field(source, "name")
    date_field = _date_field(source)
    group_field = next((field for field in source.fields if field.type == "Select"), name)
    scalar_module, measure = _scalar_source(pack, source)
    scalar_manager = _manager_key(pack, scalar_module.department, scalar_module.key)
    if not scalar_manager:
        raise ValueError("OpenView aggregate control has no module manager")
    scalar_dimension = next(
        (field for field in scalar_module.fields if field.type == "Select"),
        _field(scalar_module, "name"),
    )
    definition = _definition(source, (name, date_field, group_field))
    scalar_definition = _definition(scalar_module, (scalar_dimension, measure))
    from_date = (dataset.anchor_date - timedelta(days=7)).isoformat()
    to_date = (dataset.anchor_date + timedelta(days=7)).isoformat()
    group_ref = _field_reference(source, group_field)
    date_ref = _field_reference(source, date_field)
    measure_ref = _field_reference(scalar_module, measure)
    scalar_group_ref = _field_reference(scalar_module, scalar_dimension)
    common: dict[str, PhaseJsonValue] = {"module_key": source.key, "definition": definition}
    queries: tuple[tuple[str, str, dict[str, PhaseJsonValue]], ...] = (
        (
            "record_query",
            manager,
            {"query": {**common, "limit": 25, "offset": 0}},
        ),
        (
            "grouped_query",
            manager,
            {
                "query": {
                    **common,
                    "group_by": group_ref,
                    "limit": 25,
                    "offset": 0,
                    "group_limit": 25,
                    "group_offset": 0,
                }
            },
        ),
        (
            "window_query",
            manager,
            {
                "query": {
                    **common,
                    "mode": "calendar",
                    "scope": "window",
                    "date_field": date_ref,
                    "from_date": from_date,
                    "to_date": to_date,
                    "limit": 25,
                    "offset": 0,
                }
            },
        ),
        (
            "aggregate_groups",
            manager,
            {
                "query": {
                    **common,
                    "mode": "groups",
                    "aggregation": "count",
                    "dimension": group_ref,
                    "limit": 12,
                    "offset": 0,
                }
            },
        ),
        (
            "aggregate_scalar",
            scalar_manager,
            {
                "query": {
                    "module_key": scalar_module.key,
                    "definition": scalar_definition,
                    "mode": "groups",
                    "aggregation": "sum",
                    "measure": measure_ref,
                    "dimension": scalar_group_ref,
                    "limit": 12,
                    "offset": 0,
                }
            },
        ),
        (
            "aggregate_date_series",
            manager,
            {
                "query": {
                    **common,
                    "mode": "date_series",
                    "aggregation": "count",
                    "date_field": date_ref,
                    "from_date": from_date,
                    "to_date": to_date,
                }
            },
        ),
        (
            "aggregate_snapshot_groups",
            manager,
            {
                "query": {
                    **common,
                    "mode": "groups",
                    "aggregation": "count",
                    "dimension": group_ref,
                }
            },
        ),
        (
            "aggregate_snapshot_date_series",
            manager,
            {
                "query": {
                    **common,
                    "mode": "date_series",
                    "aggregation": "count",
                    "date_field": date_ref,
                    "from_date": from_date,
                    "to_date": to_date,
                }
            },
        ),
    )
    actions = tuple(_query_action(operation, actor, values) for operation, actor, values in queries)
    return (*actions, batch_snapshot_action(actions[-2], actions[-1]))


def _query_response_count(operation: str, body: Mapping[str, Any], *, step: str) -> int:
    raw_items = body.get("items")
    if not isinstance(raw_items, list):
        raise SamplePhaseActionError("OpenView query returned an invalid result", step=step)
    pagination = body.get("pagination")
    if operation == "grouped_query":
        groups = body.get("groups")
        group_pagination = body.get("group_pagination")
        if not isinstance(groups, list) or not isinstance(group_pagination, Mapping):
            raise SamplePhaseActionError(
                "OpenView grouped query returned an invalid result", step=step
            )
        return len(groups)
    if not isinstance(pagination, Mapping):
        raise SamplePhaseActionError("OpenView query returned invalid pagination", step=step)
    count, total = pagination.get("count"), pagination.get("total")
    if type(count) is not int or type(total) is not int or count < 0 or total < count:
        raise SamplePhaseActionError("OpenView query returned invalid pagination", step=step)
    return total


def execute_openview_query_control(
    action: PhaseAction,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    operation = action.values.get("operation")
    if operation in {
        "aggregate_snapshot_groups",
        "aggregate_snapshot_date_series",
        "aggregate_snapshots",
    }:
        return execute_snapshot_control(action, context, on_substep=on_substep)
    path = _QUERY_PATHS.get(str(operation))
    raw_query = action.values.get("query")
    if path is None or not isinstance(raw_query, Mapping):
        raise SamplePhaseActionError("Planned OpenView query is invalid", step=action.key)
    step = str(operation)
    evidence: list[dict[str, object]] = []
    response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="POST",
        path=path,
        step=step,
        expected=200,
        on_substep=on_substep,
        json_body=_wire_references(raw_query, context, step=step),
        expected_audit_rows=0,
    )
    body = _read_json(response, step=step, request_id=_request_id(response))
    count = _query_response_count(step, body, step=step)
    return _result(
        action,
        context,
        evidence,
        [],
        extra={"query_total": count},
    )
