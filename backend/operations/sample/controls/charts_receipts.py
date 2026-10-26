"""Concrete Chart result/source DTO and step-specific receipt bindings."""

import json
from collections.abc import Mapping
from typing import Any
from uuid import UUID

from app.systems.openview.charts.schemas import ChartResponse, ChartUsageResponse
from app.systems.openview.dashboards.schemas import DashboardResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.controls import charts_consumers
from operations.sample.controls.charts import CONTROL_KEY, plan_chart_control
from operations.sample.packs.phase_types import PhaseAction


def _uuid(value: object) -> str:
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ValueError("Chart receipt identity is not canonical")
    return value


def _facts(
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    admin_id: str,
    override: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    action = plan_chart_control(dataset)
    rows = [
        row.get("safe_result", row)
        for row in manifest["control_results"]
        if isinstance(row, Mapping) and row.get("action_key") == action.key
    ]
    if override is not None:
        rows = [override]
    if len(rows) != 1:
        raise ValueError("Chart action result is not unique")
    result = rows[0]
    # The manifest lists sample people only; the administrator is recorded as admin_id.
    actors = {**manifest["actor_ids"], "admin": admin_id}
    mappings = manifest["mappings"]
    if (
        result["action_key"],
        result["target_key"],
        result["actor_key"],
        result["actor_id"],
        result["outcome"],
    ) != (
        action.key,
        action.target_key,
        action.actor_key,
        actors[action.actor_key],
        "completed",
    ) or any(result.get(key) is not value for key, value in action.expected_end_state.items()):
        raise ValueError("Chart attribution or outcome differs")
    ids = {
        key: _uuid(result[key])
        for key in ("chart_id", "dashboard_id", "source_dashboard_id")
    }
    if len(set(ids.values())) != len(ids):
        raise ValueError("Chart owned identities alias a source or one another")
    if (
        ids["source_dashboard_id"] != mappings["dashboards"][action.values["source_dashboard_key"]]
        or ids["dashboard_id"] != mappings["control_dashboards"][CONTROL_KEY]
        or ids["chart_id"] != mappings["control_charts"][CONTROL_KEY]
    ):
        raise ValueError("Chart owned mappings differ from creation")
    owned = {
        ("control_charts", CONTROL_KEY): ids["chart_id"],
        ("control_dashboards", CONTROL_KEY): ids["dashboard_id"],
    }
    for target, identifier in owned.items():
        if any(
            identifier == value and (kind, key) != target
            for kind, values in mappings.items()
            if kind in {"boards", "dashboards", "charts"} or kind.startswith("control_")
            for key, value in values.items()
        ):
            raise ValueError("Chart copy aliases an authored or other owned resource")
    receipts = result["read_receipts"]
    if not isinstance(receipts, list) or any(not isinstance(row, Mapping) for row in receipts):
        raise ValueError("Chart read receipts are incomplete")
    grouped: dict[str, list[Mapping[str, Any]]] = {}
    seen = set()
    for row in receipts:
        identifier = _uuid(row["request_id"])
        if (
            identifier in seen
            or row["actor_key"] not in {"admin", action.actor_key}
            or row["actor_id"] != actors[row["actor_key"]]
        ):
            raise ValueError("Chart read attribution/request identity differs")
        seen.add(identifier)
        grouped.setdefault(row["step"], []).append(row)
    required = [
        "read_authored_dashboard",
        "create_chart",
        "read_created_chart",
        "edit_chart",
        "read_edited_chart",
        "create_chart_dashboard",
        "attach_dashboard_chart",
        "read_populated_dashboard",
        "read_cleared_dashboard",
        "read_archived_dashboard",
        "final_authored_dashboard",
        "usage_manager",
        "usage_admin",
        "usage_empty",
        "read_blocked_chart",
        "read_archive_chart",
        "read_restore_chart",
        "restore_chart",
        "read_final_archive_chart",
    ]
    if any(len(grouped.get(step, [])) != 1 for step in required):
        raise ValueError("Chart required complete read/mutation receipts are missing or duplicated")
    single = {step: grouped[step][0] for step in required}
    source_dashboard = DashboardResponse.model_validate_json(
        json.dumps(single["read_authored_dashboard"]["response"]), strict=True
    )
    if (
        str(source_dashboard.id) != ids["source_dashboard_id"]
        or str(source_dashboard.department_id)
        != mappings["departments"][action.values["department_key"]]
    ):
        raise ValueError("Chart original source binding differs")
    if single["read_authored_dashboard"]["response"] != single["final_authored_dashboard"][
        "response"
    ]:
        raise ValueError("Chart authored source survival differs")
    source_charts = {}
    referenced_ids = {
        str(row.chart_id) for row in source_dashboard.widgets if row.chart_id is not None
    }
    for identifier in referenced_ids:
        initial_rows = grouped.get("read_source_chart:" + identifier, [])
        final_rows = grouped.get("final_source_chart:" + identifier, [])
        if (
            len(initial_rows) != 1
            or len(final_rows) != 1
            or initial_rows[0]["response"] != final_rows[0]["response"]
        ):
            raise ValueError("Authored saved Chart source survival differs")
        source = ChartResponse.model_validate_json(
            json.dumps(initial_rows[0]["response"]), strict=True
        )
        if str(source.id) != identifier:
            raise ValueError("Authored saved Chart source identity differs")
        source_charts[identifier] = source
    chart = ChartResponse.model_validate_json(json.dumps(result["chart"]), strict=True)
    created = ChartResponse.model_validate_json(
        json.dumps(single["create_chart"]["response"]), strict=True
    )
    if (
        str(chart.id) != ids["chart_id"]
        or chart.revision != 5
        or not chart.is_deleted
        or created.revision != 1
        or created.is_deleted
        or chart.query != created.query
        or (chart.module_id, chart.department_id, chart.chart_type, chart.name)
        != (
            created.module_id,
            created.department_id,
            created.chart_type,
            action.values["edited_name"],
        )
    ):
        raise ValueError("Chart final instructions or metadata differ")
    if (
        str(created.module_id) != mappings["modules"][action.values["module_key"]]
        or str(created.department_id) != mappings["departments"][action.values["department_key"]]
        or created.chart_type != "bar"
        or created.name != action.values["temporary_name"]
    ):
        raise ValueError("Created Chart does not belong to planned source")
    from operations.sample.controls.charts_verification import verify_chart_list

    if not verify_chart_list(created, action, receipts)[1]:
        raise ValueError("Chart list proof did not reach its final page")
    for step, revision, archived in [
        ("read_created_chart", 1, False),
        ("read_edited_chart", 2, False),
        ("read_blocked_chart", 2, False),
        ("read_archive_chart", 3, True),
        ("read_restore_chart", 4, False),
        ("read_final_archive_chart", 5, True),
    ]:
        state = ChartResponse.model_validate_json(json.dumps(single[step]["response"]), strict=True)
        expected = {
            **created.model_dump(mode="json", exclude={"updated_at"}),
            "name": action.values["temporary_name" if revision == 1 else "edited_name"],
            "revision": revision,
            "is_deleted": archived,
        }
        if state.model_dump(mode="json", exclude={"updated_at"}) != expected:
            raise ValueError("Chart lifecycle independent readback differs")
    if single["restore_chart"]["response"] != single["read_restore_chart"]["response"]:
        raise ValueError("Full restore response differs from its expected current state")
    dashboard_name = single["create_chart_dashboard"]["response"]["name"]
    for step, wanted in [
        ("usage_manager", {("dashboard", ids["dashboard_id"], dashboard_name)}),
        ("usage_admin", {("dashboard", ids["dashboard_id"], dashboard_name)}),
        ("usage_empty", set()),
    ]:
        usage = ChartUsageResponse.model_validate_json(
            json.dumps(single[step]["response"]), strict=True
        )
        if (
            {(row.kind, str(row.id), row.name) for row in usage.items} != wanted
            or len(usage.items) != len(wanted)
            or usage.has_restricted_usage
            or (
                usage.pagination.total,
                usage.pagination.count,
                usage.pagination.offset,
                usage.pagination.has_more,
            )
            != (len(wanted), len(wanted), 0, False)
        ):
            raise ValueError("Chart usage visibility differs")
    dashboard = DashboardResponse.model_validate_json(json.dumps(result["dashboard"]), strict=True)
    expected_dashboard = {
        **single["create_chart_dashboard"]["response"],
        "revision": 4,
        "is_deleted": True,
        "widgets": [],
        "updated_at": dashboard.model_dump(mode="json")["updated_at"],
    }
    if (
        dashboard.model_dump(mode="json") != expected_dashboard
        or str(dashboard.id) != ids["dashboard_id"]
        or single["read_archived_dashboard"]["response"] != result["dashboard"]
        or single["read_cleared_dashboard"]["response"]["widgets"] != []
        or single["read_cleared_dashboard"]["response"]["revision"] != 3
    ):
        raise ValueError("Owned retained Dashboard is not the original empty archived copy")
    _bind_steps(action, ids, actors, single, receipts, created, source_dashboard, source_charts)
    return {
        "action": action,
        "result": result,
        "ids": ids,
        "receipts": receipts,
        "single": single,
        "chart": chart,
        "dashboard": dashboard,
        "source_dashboard": source_dashboard,
        "source_charts": source_charts,
        "actors": actors,
        "admin_id": admin_id,
    }


def _bind_steps(
    action: PhaseAction,
    ids: Mapping[str, str],
    actors: Mapping[str, str],
    single: Mapping[str, Mapping[str, Any]],
    receipts: list[Mapping[str, Any]],
    created: ChartResponse,
    source_dashboard: DashboardResponse,
    source_charts: dict[str, ChartResponse],
) -> None:
    root = f"/api/charts/{ids['chart_id']}"
    dashboard = f"/api/dashboards/{ids['dashboard_id']}"
    manager = action.actor_key
    routes = {
        "read_authored_dashboard": (
            "GET",
            f"/api/dashboards/{ids['source_dashboard_id']}",
            200,
            "admin",
        ),
        "create_chart": ("POST", "/api/charts", 201, manager),
        "edit_chart": ("PATCH", root, 200, manager),
        "read_created_chart": ("GET", root, 200, manager),
        "read_edited_chart": ("GET", root, 200, manager),
        "read_blocked_chart": ("GET", root, 200, manager),
        "read_archive_chart": ("GET", root, 200, manager),
        "read_restore_chart": ("GET", root, 200, manager),
        "read_final_archive_chart": ("GET", root, 200, manager),
        "usage_manager": ("GET", root + "/usage", 200, manager),
        "usage_admin": ("GET", root + "/usage", 200, "admin"),
        "usage_empty": ("GET", root + "/usage", 200, "admin"),
        "archive_in_use_chart": ("DELETE", root, 409, manager),
        "create_chart_dashboard": ("POST", "/api/dashboards", 201, "admin"),
        "attach_dashboard_chart": ("PATCH", dashboard, 200, "admin"),
        "read_populated_dashboard": ("GET", dashboard, 200, "admin"),
        "clear_chart_dashboard": ("PATCH", dashboard, 200, "admin"),
        "read_cleared_dashboard": ("GET", dashboard, 200, "admin"),
        "archive_chart_dashboard": ("DELETE", dashboard, 204, "admin"),
        "read_archived_dashboard": ("GET", dashboard, 200, "admin"),
        "archive_chart": ("DELETE", root, 204, manager),
        "restore_chart": ("POST", root + "/restore", 200, manager),
        "final_archive_chart": ("DELETE", root, 204, manager),
    }
    routes["final_authored_dashboard"] = routes["read_authored_dashboard"]
    required = set(routes)
    for row in receipts:
        step = row["step"]
        if step.startswith("list_chart_"):
            wanted = ("GET", "/api/charts", 200, manager)
        elif step.startswith(("read_source_chart:", "final_source_chart:")):
            identifier = step.split(":", 1)[1]
            if identifier not in source_charts:
                raise ValueError("Authored saved Chart source is unbound")
            wanted = ("GET", f"/api/charts/{identifier}", 200, "admin")
        else:
            wanted = routes[step]
            required.discard(step)
        if (row["method"], row["path"], row["status_code"], row["actor_key"]) != wanted or row[
            "actor_id"
        ] != actors[wanted[3]]:
            raise ValueError("Step-specific Chart read/write binding differs")
    if required:
        raise ValueError("Step-specific Chart receipts missing")
    dashboard_create: dict[str, Any] = {
        "department_id": str(source_dashboard.department_id),
        "name": str(action.values["temporary_name"]) + " dashboard",
        "position": source_dashboard.position,
        "refresh_cadence": source_dashboard.refresh_cadence,
        "widgets": [
            row.model_dump(mode="json", include=charts_consumers.DASHBOARD_SPEC_FIELDS)
            for row in source_dashboard.widgets
        ],
    }
    if single["create_chart_dashboard"]["request_body"] != dashboard_create or single[
        "create_chart"
    ]["request_body"] != {
        "module_id": str(created.module_id),
        "name": action.values["temporary_name"],
        "chart_type": "bar",
        "query": created.query.model_dump(mode="json"),
    }:
        raise ValueError("Original create request differs from source")
    clear = next(row for row in receipts if row["step"] == "clear_chart_dashboard")
    if clear["request_body"] != {"revision": 2, "widgets": []}:
        raise ValueError("Original Dashboard clear request differs")
    specs = dashboard_create["widgets"]
    expected_append = {
        "revision": 1,
        "widgets": [
            *specs,
            {
                "widget_type": "chart",
                **charts_consumers.APPENDED_CHART_CELLS,
                "chart_id": ids["chart_id"],
                "config": None,
            },
        ],
    }
    if single["attach_dashboard_chart"]["request_body"] != expected_append:
        raise ValueError("Original Dashboard append query or layout differs")
