"""Owned Chart consumer copy, transfer and guarded disposal; existing API helpers only."""

import json
from dataclasses import replace
from typing import TYPE_CHECKING, Any

import httpx
from pydantic import BaseModel, ValidationError

from app.systems.boards.portability import PortabilityError, parse_portable_board
from app.systems.boards.portability_schemas import PortableBoardBundle
from app.systems.boards.schemas import BoardResponse
from app.systems.boards.widget_schemas import BoardWidgetListResponse, BoardWidgetMutationResponse
from app.systems.openview.charts.schemas import ChartResponse, ChartUsageResponse
from app.systems.openview.dashboards.schemas import DashboardResponse
from operations.sample.controls.board_execution import (
    _create_copy,
    _purge_copy,
    _request_bytes,
)
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import SamplePhaseActionError, _record_mapping

if TYPE_CHECKING:
    from operations.sample.controls.charts import _Journey


def _model[T: BaseModel](schema: type[T], response: httpx.Response, step: str) -> T:
    try:
        return schema.model_validate_json(response.content, strict=True)
    except ValidationError:
        raise SamplePhaseActionError("Chart control response is invalid", step=step) from None


def _board_specs(widgets: BoardWidgetListResponse) -> list[dict[str, object]]:
    return [
        row.model_dump(
            mode="json",
            include={
                "name",
                "widget_type",
                "module_id",
                "position",
                "size",
                "pinned",
                "chart_id",
                "config",
            },
        )
        for row in widgets.items
    ]


def _dashboard_specs(dashboard: DashboardResponse) -> list[dict[str, object]]:
    return [
        row.model_dump(mode="json", include={"widget_type", "size", "chart_id", "config"})
        for row in dashboard.widgets
    ]


def _consumer_ids(journey: "_Journey") -> set[str]:
    return {
        identifier
        for mappings in (journey.context.mappings, journey.context.runtime_mappings)
        for kind, values in mappings.items()
        if kind in {"boards", "dashboards", "charts"} or kind.startswith("control_")
        for identifier in values.values()
    }


def read_source_charts(
    journey: "_Journey",
    widgets: BoardWidgetListResponse,
    dashboard: DashboardResponse,
    *,
    final: bool = False,
) -> dict[str, ChartResponse]:
    ids = {str(row.chart_id) for row in widgets.items if row.chart_id is not None} | {
        str(row.chart_id) for row in dashboard.widgets if row.chart_id is not None
    }
    result = {}
    for identifier in sorted(ids):
        step = ("final_source_chart:" if final else "read_source_chart:") + identifier
        chart = _model(
            ChartResponse, journey.call("GET", f"/api/charts/{identifier}", step, admin=True), step
        )
        if str(chart.id) != identifier:
            raise SamplePhaseActionError("Authored Chart reference identity differs", step=step)
        result[identifier] = chart
    return result


def inline_board_specs(
    widgets: BoardWidgetListResponse, charts: dict[str, ChartResponse]
) -> list[dict[str, object]]:
    specs = _board_specs(widgets)
    for spec in specs:
        if spec["chart_id"] is not None:
            chart = charts[str(spec["chart_id"])]
            if str(chart.module_id) != spec["module_id"]:
                raise SamplePhaseActionError(
                    "Authored Chart module differs", step="read_source_chart"
                )
            spec["chart_id"] = None
            spec["config"] = {
                "version": 1,
                "query": chart.query.model_dump(mode="json"),
                **({"chart_type": chart.chart_type} if spec["widget_type"] == "chart" else {}),
            }
    return specs


def prepare_consumers(
    journey: "_Journey",
    chart: ChartResponse,
    before_dashboard: DashboardResponse,
    before_widgets: BoardWidgetListResponse,
    module_id: str,
    department_id: str,
    source_board: str,
    source_dashboard: str,
) -> tuple[PhaseAction, str, BoardWidgetMutationResponse, DashboardResponse, str, str]:
    action, context, on_substep = journey.action, journey.context, journey.on_substep
    values = action.values
    admin_action = replace(action, actor_key="admin", target_key=action.target_key + ":board")
    protected = _consumer_ids(journey) | {source_board, source_dashboard, str(chart.id)}
    _create_copy(
        admin_action,
        context,
        journey.evidence,
        journey.mappings,
        on_substep=on_substep,
        imported=False,
    )
    board_id = context.runtime_mappings["control_boards"][admin_action.target_key]
    if board_id in protected:
        raise SamplePhaseActionError(
            "Chart Board copy aliases an authored object", step="duplicate_board"
        )
    board = _model(
        BoardResponse,
        journey.call("GET", f"/api/boards/{board_id}", "read_chart_board", admin=True),
        action.key,
    )
    copied = _model(
        BoardWidgetListResponse,
        journey.call(
            "GET", f"/api/boards/{board_id}/widgets", "read_chart_board_widgets", admin=True
        ),
        "read_chart_board_widgets",
    )
    if (
        _board_specs(copied) != _board_specs(before_widgets)
        or copied.pagination.has_more
        or len(copied.items) != copied.pagination.total
        or any(str(row.board_id) != board_id for row in copied.items)
    ):
        raise SamplePhaseActionError(
            "Copied Board sources or presentation differ", step="read_chart_board_widgets"
        )
    attached = _model(
        BoardWidgetMutationResponse,
        journey.call(
            "POST",
            f"/api/boards/{board_id}/widgets",
            "attach_board_chart",
            201,
            admin=True,
            body={
                "revision": board.revision,
                "widget": {
                    "name": "Chart control reference",
                    "widget_type": "chart",
                    "module_id": module_id,
                    "chart_id": str(chart.id),
                    "config": None,
                    "size": "S",
                    "pinned": True,
                },
            },
            entity="board_widgets",
            mutation="create",
        ),
        "attach_board_chart",
    )
    if (
        attached.widget.chart_id != chart.id
        or attached.widget.config is not None
        or attached.widget.size != "S"
        or not attached.widget.pinned
        or str(attached.widget.board_id) != board_id
        or attached.board_revision != board.revision + 1
    ):
        raise SamplePhaseActionError(
            "Board reference or presentation differs", step="attach_board_chart"
        )
    journey.evidence[-1]["primary_entity_id"] = str(attached.widget.id)
    copy_reply = journey.call(
        "POST",
        "/api/dashboards",
        "create_chart_dashboard",
        201,
        admin=True,
        body={
            "department_id": department_id,
            "name": str(values["temporary_name"]) + " dashboard",
            "position": before_dashboard.position,
            "refresh_cadence": before_dashboard.refresh_cadence,
            "widgets": [
                row.model_dump(mode="json", include={"widget_type", "size", "chart_id", "config"})
                for row in before_dashboard.widgets
            ],
        },
        entity="dashboards",
        mutation="create",
    )
    dashboard = _model(DashboardResponse, copy_reply, "create_chart_dashboard")
    dashboard_id = str(dashboard.id)
    if (
        dashboard_id in _consumer_ids(journey)
        or dashboard.revision != 1
        or dashboard.is_deleted
        or str(dashboard.department_id) != department_id
        or copy_reply.headers.get("Location") != f"/api/dashboards/{dashboard_id}"
        or _dashboard_specs(dashboard) != _dashboard_specs(before_dashboard)
        or (dashboard.name, dashboard.position, dashboard.refresh_cadence)
        != (
            str(values["temporary_name"]) + " dashboard",
            before_dashboard.position,
            before_dashboard.refresh_cadence,
        )
    ):
        raise SamplePhaseActionError(
            "Dashboard copy identity differs", step="create_chart_dashboard"
        )
    journey.evidence[-1]["primary_entity_id"] = dashboard_id
    _record_mapping(
        context,
        context.clients["admin"],
        "control_dashboards",
        action.target_key,
        dashboard_id,
        journey.mappings,
    )
    dashboard_path = f"/api/dashboards/{dashboard_id}"
    copied_specs = [
        row.model_dump(mode="json", include={"widget_type", "size", "chart_id", "config"})
        for row in dashboard.widgets
    ]
    metadata = dashboard.model_dump(mode="json", exclude={"widgets", "revision", "updated_at"})
    dashboard = _model(
        DashboardResponse,
        journey.call(
            "PATCH",
            dashboard_path,
            "attach_dashboard_chart",
            admin=True,
            body={
                "revision": 1,
                "widgets": [
                    *copied_specs,
                    {
                        "widget_type": "chart",
                        "size": "S",
                        "chart_id": str(chart.id),
                        "config": None,
                    },
                ],
            },
            entity="dashboards",
            entity_id=dashboard_id,
            mutation="update",
        ),
        "attach_dashboard_chart",
    )
    if (
        dashboard.revision != 2
        or len(dashboard.widgets) != len(copied_specs) + 1
        or dashboard.widgets[-1].chart_id != chart.id
        or dashboard.widgets[-1].config is not None
        or dashboard.widgets[-1].size != "S"
        or dashboard.widgets[-1].widget_type != "chart"
        or _dashboard_specs(dashboard)[:-1] != copied_specs
        or dashboard.model_dump(mode="json", exclude={"widgets", "revision", "updated_at"})
        != metadata
        or any(row.position != index for index, row in enumerate(dashboard.widgets))
    ):
        raise SamplePhaseActionError("Dashboard reference differs", step="attach_dashboard_chart")
    populated = _model(
        DashboardResponse,
        journey.call("GET", dashboard_path, "read_populated_dashboard", admin=True),
        "read_populated_dashboard",
    )
    if populated != dashboard:
        raise SamplePhaseActionError(
            "Populated Dashboard full readback differs", step="read_populated_dashboard"
        )
    return admin_action, board_id, attached, dashboard, dashboard_id, dashboard_path


def transfer_and_clear(
    journey: "_Journey",
    admin_action: PhaseAction,
    chart: ChartResponse,
    query: dict[str, Any],
    source_board: str,
    source_dashboard: str,
    board_id: str,
    dashboard_id: str,
    dashboard_path: str,
    attached: BoardWidgetMutationResponse,
    source_charts: dict[str, ChartResponse],
) -> tuple[str, PortableBoardBundle, bytes]:
    action, context, on_substep = journey.action, journey.context, journey.on_substep
    root = f"/api/charts/{chart.id}"
    response = journey.call(
        "GET", f"/api/boards/{board_id}/configuration", "export_board_configuration", admin=True
    )
    raw = response.content
    if (
        response.headers.get("Content-Type", "").partition(";")[0].strip().lower()
        != "application/json"
        or response.headers.get("Content-Disposition")
        != 'attachment; filename="board-configuration.json"'
        or not 0 < len(raw) <= 1024 * 1024
    ):
        raise SamplePhaseActionError(
            "Board configuration could not be exported", step="export_board_configuration"
        )
    try:
        bundle = parse_portable_board(raw)
        from operations.sample.controls.charts_verification import verify_chart_export

        verify_chart_export(journey.dataset, action, chart, bundle)
    except (ValidationError, PortabilityError, ValueError):
        raise SamplePhaseActionError(
            "Normalized Board export is invalid", step="export_board_configuration"
        ) from None
    imported_reply = _request_bytes(
        admin_action,
        context,
        journey.evidence,
        path="/api/boards/import",
        content=raw,
        on_substep=on_substep,
    )
    imported = _model(BoardResponse, imported_reply, "import_board")
    import_id = str(imported.id)
    if (
        import_id in _consumer_ids(journey)
        or imported.scope != "project"
        or imported.status != "active"
        or imported_reply.headers.get("Location") != f"/api/boards/{import_id}"
    ):
        raise SamplePhaseActionError("Imported Board identity differs", step="import_board")
    journey.evidence[-1]["primary_entity_id"] = import_id
    _record_mapping(
        context,
        context.clients["admin"],
        "control_boards",
        action.target_key + ":import",
        import_id,
        journey.mappings,
    )
    imported_widgets = _model(
        BoardWidgetListResponse,
        journey.call(
            "GET", f"/api/boards/{import_id}/widgets", "read_imported_chart_widgets", admin=True
        ),
        action.key,
    )
    matches = imported_widgets.items[-1:]
    if (
        len(matches) != 1
        or matches[0].chart_id is not None
        or matches[0].config is None
        or matches[0].size != "S"
        or not matches[0].pinned
        or matches[0].config.model_dump(mode="json")["query"] != query
        or matches[0].widget_type != "chart"
        or str(matches[0].module_id) != str(chart.module_id)
        or imported_widgets.pagination.has_more
        or imported_widgets.pagination.total != len(imported_widgets.items)
    ):
        raise SamplePhaseActionError(
            "Imported Chart instructions or layout differ", step="read_imported_chart_widgets"
        )
    before = next(
        row["response"] for row in journey.receipts if row["step"] == "read_chart_board_widgets"
    )
    original = BoardWidgetListResponse.model_validate_json(json.dumps(before), strict=True)
    if _board_specs(imported_widgets)[:-1] != inline_board_specs(original, source_charts):
        raise SamplePhaseActionError(
            "Imported incumbent sources or layout differ", step="read_imported_chart_widgets"
        )
    journey.call(
        "DELETE",
        f"/api/boards/{board_id}/widgets/{attached.widget.id}",
        "delete_board_chart",
        204,
        admin=True,
        body={"revision": attached.board_revision},
        entity="board_widgets",
        entity_id=str(attached.widget.id),
        mutation="delete",
    )
    cleared = _model(
        DashboardResponse,
        journey.call(
            "PATCH",
            dashboard_path,
            "clear_chart_dashboard",
            admin=True,
            body={"revision": 2, "widgets": []},
            entity="dashboards",
            entity_id=dashboard_id,
            mutation="update",
        ),
        "clear_chart_dashboard",
    )
    if cleared.revision != 3 or cleared.widgets:
        raise SamplePhaseActionError(
            "Owned Dashboard was not cleared", step="clear_chart_dashboard"
        )
    reread = _model(
        DashboardResponse,
        journey.call("GET", dashboard_path, "read_cleared_dashboard", admin=True),
        action.key,
    )
    if reread != cleared:
        raise SamplePhaseActionError(
            "Cleared Dashboard readback differs", step="read_cleared_dashboard"
        )
    empty = _model(
        ChartUsageResponse,
        journey.call("GET", root + "/usage", "usage_empty", admin=True),
        action.key,
    )
    if empty.items or empty.pagination.total or empty.has_restricted_usage:
        raise SamplePhaseActionError("Chart references remain", step="usage_empty")
    return import_id, bundle, raw


def dispose_consumers(
    journey: "_Journey",
    admin_action: PhaseAction,
    board_id: str,
    import_id: str,
    dashboard_id: str,
    dashboard_path: str,
) -> DashboardResponse:
    action, context, on_substep = journey.action, journey.context, journey.on_substep
    for key, identifier in [
        (admin_action.target_key, board_id),
        (action.target_key + ":import", import_id),
    ]:
        _purge_copy(
            replace(admin_action, target_key=key),
            context,
            journey.evidence,
            journey.mappings,
            identifier,
            on_substep=on_substep,
        )
        journey.call("GET", f"/api/boards/{identifier}", "read_absent_board", 404, admin=True)
    journey.call(
        "DELETE",
        dashboard_path,
        "archive_chart_dashboard",
        204,
        admin=True,
        params={"revision": 3},
        entity="dashboards",
        entity_id=dashboard_id,
        mutation="update",
    )
    final_dashboard = _model(
        DashboardResponse,
        journey.call("GET", dashboard_path, "read_archived_dashboard", admin=True),
        action.key,
    )
    if final_dashboard.revision != 4 or not final_dashboard.is_deleted or final_dashboard.widgets:
        raise SamplePhaseActionError(
            "Retained owned Dashboard is not empty and archived", step="read_archived_dashboard"
        )
    return final_dashboard
