"""Concrete Chart result/source/portable DTO and step-specific receipt bindings."""

import hashlib
import json
from collections.abc import Mapping
from typing import Any
from uuid import UUID

from app.systems.boards.portability import parse_portable_board
from app.systems.boards.schemas import BoardResponse
from app.systems.boards.widget_schemas import BoardWidgetListResponse
from app.systems.openview.charts.schemas import ChartResponse, ChartUsageResponse
from app.systems.openview.dashboards.schemas import DashboardResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.controls.charts import CONTROL_KEY, plan_chart_control
from operations.sample.controls.charts_consumers import _board_specs, inline_board_specs
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
        for key in (
            "chart_id",
            "board_id",
            "dashboard_id",
            "import_id",
            "source_board_id",
            "source_dashboard_id",
        )
    }
    if len(set(ids.values())) != len(ids):
        raise ValueError("Chart owned identities alias a source or one another")
    if (
        ids["source_board_id"] != mappings["boards"][action.values["source_board_key"]]
        or ids["source_dashboard_id"]
        != mappings["dashboards"][action.values["source_dashboard_key"]]
        or ids["dashboard_id"] != mappings["control_dashboards"][CONTROL_KEY]
        or ids["chart_id"] != mappings["control_charts"][CONTROL_KEY]
        or ids["board_id"] != mappings["control_boards"][CONTROL_KEY + ":board"]
        or ids["import_id"] != mappings["control_boards"][CONTROL_KEY + ":import"]
    ):
        raise ValueError("Chart owned mappings differ from creation")
    owned = {
        ("control_charts", CONTROL_KEY): ids["chart_id"],
        ("control_dashboards", CONTROL_KEY): ids["dashboard_id"],
        ("control_boards", CONTROL_KEY + ":board"): ids["board_id"],
        ("control_boards", CONTROL_KEY + ":import"): ids["import_id"],
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
        "read_authored_board",
        "read_authored_widgets",
        "read_authored_dashboard",
        "create_chart",
        "read_created_chart",
        "edit_chart",
        "read_edited_chart",
        "create_chart_dashboard",
        "attach_dashboard_chart",
        "read_populated_dashboard",
        "attach_board_chart",
        "read_chart_board",
        "read_chart_board_widgets",
        "export_board_configuration",
        "read_cleared_dashboard",
        "read_archived_dashboard",
        "final_authored_board",
        "final_authored_widgets",
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
    source_board = BoardResponse.model_validate_json(
        json.dumps(single["read_authored_board"]["response"]), strict=True
    )
    source_widgets = BoardWidgetListResponse.model_validate_json(
        json.dumps(single["read_authored_widgets"]["response"]), strict=True
    )
    source_dashboard = DashboardResponse.model_validate_json(
        json.dumps(single["read_authored_dashboard"]["response"]), strict=True
    )
    if (
        str(source_board.id) != ids["source_board_id"]
        or str(source_dashboard.id) != ids["source_dashboard_id"]
        or str(source_dashboard.department_id)
        != mappings["departments"][action.values["department_key"]]
        or source_widgets.pagination.has_more
        or source_widgets.pagination.total != len(source_widgets.items)
        or any(str(row.board_id) != ids["source_board_id"] for row in source_widgets.items)
    ):
        raise ValueError("Chart original source binding differs")
    for initial, final in [
        ("read_authored_board", "final_authored_board"),
        ("read_authored_widgets", "final_authored_widgets"),
        ("read_authored_dashboard", "final_authored_dashboard"),
    ]:
        if single[initial]["response"] != single[final]["response"]:
            raise ValueError("Chart authored source survival differs")
    source_charts = {}
    referenced_ids = {str(row.chart_id) for row in source_widgets.items if row.chart_id is not None}
    referenced_ids |= {
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
    board_name = BoardResponse.model_validate_json(
        json.dumps(single["read_chart_board"]["response"]), strict=True
    ).name
    dashboard_name = single["create_chart_dashboard"]["response"]["name"]
    for step, wanted, restricted in [
        ("usage_manager", {("dashboard", ids["dashboard_id"], dashboard_name)}, True),
        (
            "usage_admin",
            {
                ("board", ids["board_id"], board_name),
                ("dashboard", ids["dashboard_id"], dashboard_name),
            },
            False,
        ),
        ("usage_empty", set(), False),
    ]:
        usage = ChartUsageResponse.model_validate_json(
            json.dumps(single[step]["response"]), strict=True
        )
        if (
            {(row.kind, str(row.id), row.name) for row in usage.items} != wanted
            or len(usage.items) != len(wanted)
            or usage.has_restricted_usage != restricted
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
    raw = result["portable_bytes"].encode("utf-8")
    bundle = parse_portable_board(raw)
    if (
        hashlib.sha256(raw).hexdigest() != result["portable_sha256"]
        or hashlib.sha256(raw).hexdigest()
        != single["export_board_configuration"]["response_sha256"]
        or json.loads(raw) != single["export_board_configuration"]["response"]
        or bundle.model_dump(mode="json") != result["portable_bundle"]
    ):
        raise ValueError("Chart portable bytes/grammar binding differs")
    _bind_steps(
        dataset,
        action,
        result,
        ids,
        actors,
        single,
        receipts,
        created,
        source_dashboard,
        source_charts,
    )
    return {
        "action": action,
        "result": result,
        "ids": ids,
        "receipts": receipts,
        "single": single,
        "chart": chart,
        "dashboard": dashboard,
        "source_board": source_board,
        "source_widgets": source_widgets,
        "source_dashboard": source_dashboard,
        "source_charts": source_charts,
        "actors": actors,
        "admin_id": admin_id,
    }


def _bind_steps(
    dataset: SampleDataset,
    action: PhaseAction,
    result: Mapping[str, Any],
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
        "read_authored_board": ("GET", f"/api/boards/{ids['source_board_id']}", 200, "admin"),
        "read_authored_widgets": (
            "GET",
            f"/api/boards/{ids['source_board_id']}/widgets",
            200,
            "admin",
        ),
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
        "read_chart_board": ("GET", f"/api/boards/{ids['board_id']}", 200, "admin"),
        "read_chart_board_widgets": ("GET", f"/api/boards/{ids['board_id']}/widgets", 200, "admin"),
        "export_board_configuration": (
            "GET",
            f"/api/boards/{ids['board_id']}/configuration",
            200,
            "admin",
        ),
        "attach_board_chart": ("POST", f"/api/boards/{ids['board_id']}/widgets", 201, "admin"),
        "create_chart_dashboard": ("POST", "/api/dashboards", 201, "admin"),
        "attach_dashboard_chart": ("PATCH", dashboard, 200, "admin"),
        "read_populated_dashboard": ("GET", dashboard, 200, "admin"),
        "delete_board_chart": (
            "DELETE",
            f"/api/boards/{ids['board_id']}/widgets/"
            + single["attach_board_chart"]["response"]["widget"]["id"],
            204,
            "admin",
        ),
        "clear_chart_dashboard": ("PATCH", dashboard, 200, "admin"),
        "read_cleared_dashboard": ("GET", dashboard, 200, "admin"),
        "archive_chart_dashboard": ("DELETE", dashboard, 204, "admin"),
        "read_archived_dashboard": ("GET", dashboard, 200, "admin"),
        "read_imported_chart_widgets": (
            "GET",
            f"/api/boards/{ids['import_id']}/widgets",
            200,
            "admin",
        ),
        "archive_chart": ("DELETE", root, 204, manager),
        "restore_chart": ("POST", root + "/restore", 200, manager),
        "final_archive_chart": ("DELETE", root, 204, manager),
    }
    for initial, final in [
        ("read_authored_board", "final_authored_board"),
        ("read_authored_widgets", "final_authored_widgets"),
        ("read_authored_dashboard", "final_authored_dashboard"),
    ]:
        routes[final] = routes[initial]
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
        elif step == "read_absent_board":
            if row["path"] not in {
                f"/api/boards/{ids['board_id']}",
                f"/api/boards/{ids['import_id']}",
            }:
                raise ValueError("Absent Board read target differs")
            wanted = ("GET", row["path"], 404, "admin")
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
            row.model_dump(mode="json", include={"widget_type", "size", "chart_id", "config"})
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
                "size": "S",
                "chart_id": ids["chart_id"],
                "config": None,
            },
        ],
    }
    if single["attach_dashboard_chart"]["request_body"] != expected_append:
        raise ValueError("Original Dashboard append query or layout differs")
    bundle = parse_portable_board(result["portable_bytes"].encode())
    imports = BoardWidgetListResponse.model_validate_json(
        json.dumps(
            next(
                row["response"] for row in receipts if row["step"] == "read_imported_chart_widgets"
            )
        ),
        strict=True,
    )
    matches = imports.items[-1:]
    if (
        len(matches) != 1
        or str(matches[0].board_id) != ids["import_id"]
        or matches[0].chart_id is not None
        or matches[0].config is None
        or matches[0].size != "S"
        or matches[0].pinned is not True
        or matches[0].config.model_dump(mode="json")
        != {"version": 1, "chart_type": "bar", "query": created.query.model_dump(mode="json")}
    ):
        raise ValueError("Imported Chart query or layout differs")
    copied = BoardWidgetListResponse.model_validate_json(
        json.dumps(single["read_chart_board_widgets"]["response"]), strict=True
    )
    if _board_specs(imports)[:-1] != inline_board_specs(copied, source_charts):
        raise ValueError("Imported incumbent query or layout differs")
    from operations.sample.controls.charts_verification import verify_chart_export

    verify_chart_export(dataset, action, created, bundle)
