"""Pack-derived API control scenarios for OpenView and its record controls."""

from __future__ import annotations

from operations.sample.blueprint import SampleDataset
from operations.sample.board_text import dashboard_name, report_names, view_name
from operations.sample.controls.openview_mutations import (
    _record_lifecycle_control,
    _relationship_delete_control,
)
from operations.sample.controls.openview_purge import execute_report_purge
from operations.sample.controls.openview_queries import (
    QUERY_ROUTES,
    control_modules,
    control_name,
    execute_openview_query_control,
    make_control_action,
    plan_openview_query_controls,
    select_openview_target,
)
from operations.sample.controls.openview_verification import (
    verify_openview_controls as verify_openview_controls,
)
from operations.sample.packs.phase_types import PhaseAction, PhaseJsonValue
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _mapped_id,
    _read_json,
    _request,
    _request_id,
    _request_object,
    _result,
)
from operations.sample.phases.planning import _manager_key

_MUTATION_ROUTES = frozenset(
    {
        ("GET", "/api/records/{record_id}"),
        ("POST", "/api/records"),
        ("PATCH", "/api/records/{record_id}"),
        ("DELETE", "/api/records/{record_id}"),
        ("POST", "/api/records/{record_id}/restore"),
        ("POST", "/api/records/{record_id}/purge/preview"),
        ("POST", "/api/records/{record_id}/purge"),
        ("POST", "/api/relationships"),
        ("DELETE", "/api/relationships/{relationship_id}"),
        ("GET", "/api/views/{view_id}"),
        ("PATCH", "/api/views/{view_id}"),
        ("GET", "/api/dashboards/{dashboard_id}"),
        ("PATCH", "/api/dashboards/{dashboard_id}"),
        ("GET", "/api/reports/{report_id}"),
        ("PATCH", "/api/reports/{report_id}"),
        ("GET", "/api/reports/{report_id}/schedule"),
        ("PATCH", "/api/reports/{report_id}/schedule"),
        ("POST", "/api/reports"),
        ("DELETE", "/api/reports/{report_id}"),
        ("POST", "/api/reports/{report_id}/purge/preview"),
        ("POST", "/api/reports/{report_id}/purge"),
    }
)
CONTROL_ROUTES = QUERY_ROUTES | _MUTATION_ROUTES


def _action(
    operation: str,
    actor_key: str,
    target_key: str,
    values: dict[str, PhaseJsonValue],
    expected_end_state: dict[str, PhaseJsonValue],
) -> PhaseAction:
    return make_control_action(
        operation,
        actor_key,
        target_key,
        values,
        expected_end_state,
    )


def plan_openview_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    """Plan bounded reads, reversible edits, and purged temporary record controls."""
    pack = dataset.organization
    actions = list(plan_openview_query_controls(dataset))
    department, source, manager = select_openview_target(dataset)

    layout = pack.content.data.layouts[0]
    logical_view = f"department:{department}:view:{source.key}:{layout}"
    logical_dashboard = f"department:{department}:dashboard"
    logical_report = f"department:{department}:report:01"
    department_name = dict(pack.catalog.departments)[department]
    group_name = next((field.name for field in source.fields if field.type == "Select"), None)
    report_name, _ = report_names(source.key, "daily", group_name, organization=pack)
    edited_names = {
        "view": f"{department_name} {source.name.lower()}",
        "dashboard": f"{department_name} priorities",
        "report": report_names(source.key, "weekly", group_name, organization=pack)[0],
    }
    controls = (
        ("view_patch", manager, logical_view, {"resource_kind": "view", "module_key": source.key}),
        (
            "dashboard_patch",
            _manager_key(pack, department, source.key, department_scope=True),
            logical_dashboard,
            {"resource_kind": "dashboard", "department_key": department},
        ),
        (
            "report_patch",
            manager,
            logical_report,
            {"resource_kind": "report", "module_key": source.key, "report_name": report_name},
        ),
        (
            "schedule_patch",
            manager,
            logical_report,
            {
                "resource_kind": "report_schedule",
                "module_key": source.key,
                "report_name": report_name,
            },
        ),
    )
    if any(not actor for _, actor, _, _ in controls):
        raise ValueError("OpenView control plan has no manager for an authored resource")
    for operation, actor, logical_id, values in controls:
        resource_kind = str(values["resource_kind"])
        actions.append(
            _action(
                operation,
                actor,
                logical_id,
                {
                    **values,
                    "department_key": department,
                    **(
                        {"edited_name": edited_names[resource_kind]}
                        if resource_kind in edited_names
                        else {}
                    ),
                    "resource_name": view_name(source.key, layout, organization=pack)
                    if resource_kind == "view"
                    else dashboard_name(department_name, organization=pack)
                    if resource_kind == "dashboard"
                    else report_name,
                },
                {"resource_restored": True},
            )
        )

    trigger_free_lifecycle, relation_source, relation_target, edge = control_modules(dataset)
    relation_key = next(
        key
        for key, identifier in dataset.relationship_ids.items()
        if identifier == edge.relationship_id
    )
    relation_spec = next(item for item in pack.catalog.relationships if item.key == relation_key)
    relation_edge = next(
        candidate
        for candidate in dataset.edges
        if candidate.relationship_id == edge.relationship_id
    )
    relationship_actor = relation_edge.creator_key
    if not relationship_actor:
        relationship_actor = _manager_key(pack, relation_source.department, relation_source.key)
    if not relationship_actor:
        raise ValueError("OpenView relationship delete needs a planned source manager")
    reserved: dict[str, set[str]] = {}
    lifecycle_name = control_name(dataset, trigger_free_lifecycle, reserved)
    edited_lifecycle_name = control_name(dataset, trigger_free_lifecycle, reserved)
    relation_source_name = control_name(dataset, relation_source, reserved)
    relation_target_name = control_name(dataset, relation_target, reserved)
    lifecycle_actor = _manager_key(
        pack, trigger_free_lifecycle.department, trigger_free_lifecycle.key
    )
    if not lifecycle_actor:
        raise ValueError("OpenView record lifecycle control needs a module manager")
    actions.extend(
        (
            _action(
                "report_purge",
                "admin",
                "control:report_purge",
                {
                    "source_report_key": logical_report,
                    "module_key": source.key,
                    "temporary_name": f"{report_name[:60].rstrip()} disposal review",
                },
                {"report_physically_absent": True, "authored_source_preserved": True},
            ),
            _action(
                "record_lifecycle",
                lifecycle_actor,
                "control:record_lifecycle",
                {
                    "module_key": trigger_free_lifecycle.key,
                    "temporary_name": lifecycle_name,
                    "edited_name": edited_lifecycle_name,
                    "admin_steps": ["preview_purge_record", "purge_record"],
                },
                {"record_physically_absent": True, "record_data_restored_before_delete": True},
            ),
            _action(
                "relationship_delete",
                relationship_actor,
                "control:relationship_delete",
                {
                    "relation_key": relation_spec.key,
                    "source_module_key": relation_source.key,
                    "target_module_key": relation_target.key,
                    "target_record_key": relation_edge.target_record_id,
                    "source_temporary_name": relation_source_name,
                    "target_temporary_name": relation_target_name,
                    "admin_steps": [
                        "create_relationship_source",
                        "create_relationship_target",
                        "delete_relationship_source",
                        "delete_relationship_target",
                        "preview_purge_relationship_source",
                        "purge_relationship_source",
                        "preview_purge_relationship_target",
                        "purge_relationship_target",
                    ],
                },
                {"relationship_deleted": True, "temporary_records_physically_absent": True},
            ),
        )
    )
    return tuple(actions)


def _edit_openview_resource(
    action: PhaseAction,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    resource = action.values.get("resource_kind")
    mapping_kind, entity_type = {
        "view": ("views", "saved_views"),
        "dashboard": ("dashboards", "dashboards"),
        "report": ("reports", "reports"),
        "report_schedule": ("reports", "report_schedules"),
    }.get(str(resource), ("", ""))
    if not mapping_kind:
        raise SamplePhaseActionError("Planned OpenView resource type is invalid", step=action.key)
    resource_id = _mapped_id(context, mapping_kind, action.target_key, step="read_openview_control")
    if resource == "view":
        path = f"/api/views/{resource_id}"
    elif resource == "dashboard":
        path = f"/api/dashboards/{resource_id}"
    elif resource == "report":
        path = f"/api/reports/{resource_id}"
    else:
        path = f"/api/reports/{resource_id}/schedule"
    evidence: list[dict[str, object]] = []
    resource_state = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path=path,
        step="read_openview_control",
        on_substep=on_substep,
    )
    identity_key = "report_id" if resource == "report_schedule" else "id"
    identity = resource_state.get(identity_key)
    revision = resource_state.get("revision")
    if identity != resource_id or type(revision) is not int:
        raise SamplePhaseActionError(
            "OpenView resource revision could not be read", step="read_openview_control"
        )
    audit_entity_id = (
        _id(resource_state, "id", label="report schedule", step="read_openview_control")
        if resource == "report_schedule"
        else resource_id
    )
    if resource == "report_schedule" and resource_state.get("enabled") is not False:
        raise SamplePhaseActionError(
            "Authored sample schedule must remain disabled", step="read_openview_control"
        )
    original_field = "local_time" if resource == "report_schedule" else "name"
    original = resource_state.get(original_field)
    if not isinstance(original, str) or not original:
        raise SamplePhaseActionError(
            "OpenView resource value could not be read", step="read_openview_control"
        )
    changed = (
        ("09:01" if original != "09:01" else "09:02")
        if resource == "report_schedule"
        else action.values.get("edited_name")
    )
    if not isinstance(changed, str) or not changed or changed == original:
        raise SamplePhaseActionError("Planned OpenView edit is invalid", step=action.key)
    for value, step in (
        (changed, "patch_openview_control"),
        (original, "restore_openview_control"),
    ):
        body = {
            "revision": revision,
            "local_time" if resource == "report_schedule" else "name": value,
        }
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="PATCH",
            path=path,
            step=step,
            expected=200,
            on_substep=on_substep,
            json_body=body,
            primary_entity_type=entity_type,
            primary_entity_id=audit_entity_id,
            primary_action="update",
            expected_audit_rows=1,
        )
        updated = _read_json(response, step=step, request_id=_request_id(response))
        response_id = updated.get(identity_key)
        next_revision = updated.get("revision")
        if (
            response_id != resource_id
            or (
                resource == "report_schedule"
                and _id(updated, "id", label="report schedule", step=step) != audit_entity_id
            )
            or type(next_revision) is not int
            or next_revision != revision + 1
        ):
            raise SamplePhaseActionError(
                "OpenView update response did not match its revision", step=step
            )
        if updated.get(original_field) != value:
            raise SamplePhaseActionError(
                "OpenView update response did not save its value", step=step
            )
        revision = next_revision
        resource_state = updated
    return _result(
        action,
        context,
        evidence,
        [],
        extra={"resource_restored": resource_state.get(original_field) == original},
    )


def execute_openview_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    """Execute one query, reversible edit, or disposable record control action."""
    operation = action.values.get("operation")
    if operation in {
        "record_query",
        "grouped_query",
        "window_query",
        "aggregate_groups",
        "aggregate_scalar",
        "aggregate_date_series",
        "aggregate_snapshot_groups",
        "aggregate_snapshot_date_series",
    }:
        return execute_openview_query_control(action, context, on_substep=on_substep)
    if operation in {"view_patch", "dashboard_patch", "report_patch", "schedule_patch"}:
        return _edit_openview_resource(action, context, on_substep=on_substep)
    if operation == "record_lifecycle":
        return _record_lifecycle_control(action, dataset, context, on_substep=on_substep)
    if operation == "relationship_delete":
        return _relationship_delete_control(action, dataset, context, on_substep=on_substep)
    if operation == "report_purge":
        return execute_report_purge(action, context, on_substep=on_substep)
    raise SamplePhaseActionError("Unsupported OpenView control action", step=action.key)
