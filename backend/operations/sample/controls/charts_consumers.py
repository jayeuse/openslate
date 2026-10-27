"""Owned Chart Dashboard consumer copy, clearing and archive; existing API helpers only."""

from typing import TYPE_CHECKING

import httpx
from pydantic import BaseModel, ValidationError

from app.systems.openview.charts.schemas import ChartResponse, ChartUsageResponse
from app.systems.openview.dashboards.schemas import DashboardResponse
from operations.sample.phases.actions import SamplePhaseActionError, _record_mapping

DASHBOARD_SPEC_FIELDS = {
    "widget_type",
    "grid_column",
    "grid_row",
    "column_span",
    "row_span",
    "chart_id",
    "config",
}
# Free cells of the sample Dashboard (population/openview.py) for the appended chart.
APPENDED_CHART_CELLS = {"grid_column": 0, "grid_row": 3, "column_span": 2, "row_span": 2}

if TYPE_CHECKING:
    from operations.sample.controls.charts import _Journey


def _model[T: BaseModel](schema: type[T], response: httpx.Response, step: str) -> T:
    try:
        return schema.model_validate_json(response.content, strict=True)
    except ValidationError:
        raise SamplePhaseActionError("Chart control response is invalid", step=step) from None


def _dashboard_specs(dashboard: DashboardResponse) -> list[dict[str, object]]:
    return [
        row.model_dump(mode="json", include=DASHBOARD_SPEC_FIELDS)
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
    dashboard: DashboardResponse,
    *,
    final: bool = False,
) -> dict[str, ChartResponse]:
    ids = {str(row.chart_id) for row in dashboard.widgets if row.chart_id is not None}
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


def prepare_consumers(
    journey: "_Journey",
    chart: ChartResponse,
    before_dashboard: DashboardResponse,
    department_id: str,
) -> tuple[DashboardResponse, str, str]:
    action, context, values = journey.action, journey.context, journey.action.values
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
                row.model_dump(mode="json", include=DASHBOARD_SPEC_FIELDS)
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
        row.model_dump(mode="json", include=DASHBOARD_SPEC_FIELDS)
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
                        **APPENDED_CHART_CELLS,
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
        or dashboard.widgets[-1].model_dump(include=set(APPENDED_CHART_CELLS))
        != APPENDED_CHART_CELLS
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
    return dashboard, dashboard_id, dashboard_path


def clear_consumers(
    journey: "_Journey", chart: ChartResponse, dashboard_id: str, dashboard_path: str
) -> None:
    action = journey.action
    root = f"/api/charts/{chart.id}"
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


def dispose_consumers(
    journey: "_Journey", dashboard_id: str, dashboard_path: str
) -> DashboardResponse:
    action = journey.action
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
