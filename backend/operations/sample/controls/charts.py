"""One pack-derived real-client Chart lifecycle on an owned Dashboard consumer copy."""

import hashlib
from collections.abc import Mapping
from typing import Any

import httpx

from app.systems.openview.charts.schemas import ChartResponse, ChartUsageResponse
from app.systems.openview.dashboards.schemas import DashboardResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.controls.charts_consumers import (
    _model,
    clear_consumers,
    dispose_consumers,
    prepare_consumers,
    read_source_charts,
)
from operations.sample.controls.openview_queries import make_control_action, select_openview_target
from operations.sample.controls.openview_snapshots import _wire_references
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _client,
    _mapped_id,
    _record_mapping,
    _request,
    _request_id,
    _result,
)
from operations.sample.phases.planning import _manager_key

CHART_ROUTES = frozenset(
    {
        ("POST", "/api/charts"),
        ("GET", "/api/charts"),
        ("GET", "/api/charts/{chart_id}"),
        ("PATCH", "/api/charts/{chart_id}"),
        ("GET", "/api/charts/{chart_id}/usage"),
        ("DELETE", "/api/charts/{chart_id}"),
        ("POST", "/api/charts/{chart_id}/restore"),
    }
)
CONTROL_KEY = "control:chart_lifecycle"
ADMIN_STEPS = [
    "create_chart_dashboard",
    "attach_dashboard_chart",
    "clear_chart_dashboard",
    "archive_chart_dashboard",
]


def plan_chart_control(dataset: SampleDataset) -> PhaseAction:
    department, module, _ = select_openview_target(dataset)
    manager = _manager_key(dataset.organization, department, module.key, department_scope=True)
    phase = dataset.organization.phases
    title = next(
        (field for field in module.fields if field.key == "name" and field.type == "Text"), None
    )
    if not manager or manager == "admin" or phase is None or title is None:
        raise ValueError(
            "Chart control needs a department manager, authored sources and text title"
        )
    return make_control_action(
        "chart_lifecycle",
        manager,
        CONTROL_KEY,
        {
            "department_key": department,
            "module_key": module.key,
            "source_dashboard_key": f"department:{department}:dashboard",
            "temporary_name": "Owned Chart control",
            "edited_name": "Reviewed Chart control",
            "admin_steps": [step for step in ADMIN_STEPS],
            "query": {
                "module_key": module.key,
                "mode": "groups",
                "definition": {
                    "version": 1,
                    "columns": [],
                    "filters": [],
                    "logic": "and",
                    "sort": [],
                    "deleted": "exclude",
                    "search": None,
                    "search_fields": [],
                },
                "dimension": {"field_key": f"{module.key}:name", "expected_type": "text"},
                "aggregation": "count",
                "measure": None,
                "date_field": None,
                "from_date": None,
                "to_date": None,
            },
        },
        {"chart_archived": True, "authored_sources_preserved": True},
    )


class _Journey:
    def __init__(
        self,
        action: PhaseAction,
        dataset: SampleDataset,
        context: PhaseExecutionContext,
        on_substep: PhaseSubstep | None,
    ):
        self.action, self.context, self.on_substep = action, context, on_substep
        self.dataset = dataset
        self.evidence: list[dict[str, object]] = []
        self.mappings: list[dict[str, str]] = []
        self.receipts: list[dict[str, Any]] = []

    def call(
        self,
        method: str,
        path: str,
        step: str,
        expected: int = 200,
        *,
        admin: bool = False,
        body: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
        entity: str | None = None,
        entity_id: str | None = None,
        mutation: str | None = None,
    ) -> httpx.Response:
        actor = "admin" if admin else self.action.actor_key
        response = _request(
            self.action,
            self.context,
            self.evidence,
            actor_key=actor,
            method=method,
            path=path,
            step=step,
            expected=expected,
            on_substep=self.on_substep,
            json_body=body,
            params=params,
            primary_entity_type=entity,
            primary_entity_id=entity_id,
            primary_action=mutation,
            expected_audit_rows=1 if entity else 0,
        )
        request_id = _request_id(response)
        if request_id is None:
            raise SamplePhaseActionError(
                "Chart read/write response has no canonical request ID", step=step
            )
        self.receipts.append(
            {
                "step": step,
                "actor_key": actor,
                "actor_id": self.context.user_ids[actor],
                "method": method,
                "path": path,
                "status_code": expected,
                "request_id": request_id,
                "params": dict(params or {}),
                "request_body": dict(body) if body is not None else None,
                "response": response.json() if response.content else None,
                "response_sha256": hashlib.sha256(response.content).hexdigest(),
            }
        )
        return response

    def chart(self, path: str, step: str, expected: Mapping[str, Any]) -> ChartResponse:
        parsed = _model(ChartResponse, self.call("GET", path, step), step)
        if parsed.model_dump(mode="json") != dict(expected):
            raise SamplePhaseActionError("Chart identity, instructions or state differ", step=step)
        return parsed


def execute_chart_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    journey = _Journey(action, dataset, context, on_substep)
    values = action.values
    module_id = _mapped_id(context, "modules", str(values["module_key"]), step=action.key)
    department_id = _mapped_id(
        context, "department", str(values["department_key"]), step=action.key
    )
    source_dashboard = _mapped_id(
        context, "dashboards", str(values["source_dashboard_key"]), step=action.key
    )
    for actor in ("admin", action.actor_key):
        _client(context, actor, step=action.key)
    query = _wire_references(values["query"], context, step=action.key)
    before_dashboard = _model(
        DashboardResponse,
        journey.call(
            "GET", f"/api/dashboards/{source_dashboard}", "read_authored_dashboard", admin=True
        ),
        action.key,
    )
    if (
        str(before_dashboard.id) != source_dashboard
        or str(before_dashboard.department_id) != department_id
    ):
        raise SamplePhaseActionError("Authored Chart sources differ from mappings", step=action.key)
    source_charts = read_source_charts(journey, before_dashboard)
    created_reply = journey.call(
        "POST",
        "/api/charts",
        "create_chart",
        201,
        body={
            "module_id": module_id,
            "name": values["temporary_name"],
            "chart_type": "bar",
            "query": query,
        },
        entity="charts",
        mutation="create",
    )
    chart = _model(ChartResponse, created_reply, "create_chart")
    root = f"/api/charts/{chart.id}"
    if (
        str(chart.module_id),
        str(chart.department_id),
        chart.name,
        chart.chart_type,
        chart.query.model_dump(mode="json"),
        chart.revision,
        chart.is_deleted,
    ) != (
        module_id,
        department_id,
        values["temporary_name"],
        "bar",
        query,
        1,
        False,
    ) or created_reply.headers.get("Location") != root:
        raise SamplePhaseActionError(
            "Created Chart did not match its source and instructions", step="create_chart"
        )
    journey.evidence[-1]["primary_entity_id"] = str(chart.id)
    _record_mapping(
        context,
        context.clients[action.actor_key],
        "control_charts",
        action.target_key,
        str(chart.id),
        journey.mappings,
    )
    expected = chart.model_dump(mode="json")
    journey.chart(root, "read_created_chart", expected)
    from operations.sample.controls.charts_verification import verify_chart_list

    offset = 0
    for index in range(100):
        journey.call(
            "GET",
            "/api/charts",
            f"list_chart_{index}",
            params={
                "module_id": module_id,
                "department_id": department_id,
                "deleted": "include",
                "search": values["temporary_name"],
                "limit": 100,
                "offset": offset,
                "sort_by": "name",
                "sort_order": "asc",
            },
        )
        try:
            offset, complete = verify_chart_list(chart, action, journey.receipts)
        except (ValueError, KeyError, TypeError):
            raise SamplePhaseActionError(
                "Chart collection proof differs", step="list_chart"
            ) from None
        if complete:
            break
    else:
        raise SamplePhaseActionError("Chart list exceeded the page bound", step="list_chart")
    updated = _model(
        ChartResponse,
        journey.call(
            "PATCH",
            root,
            "edit_chart",
            body={"revision": 1, "name": values["edited_name"]},
            entity="charts",
            entity_id=str(chart.id),
            mutation="update",
        ),
        "edit_chart",
    )
    expected.update(
        name=values["edited_name"],
        revision=2,
        updated_at=updated.model_dump(mode="json")["updated_at"],
    )
    if updated.model_dump(mode="json") != expected:
        raise SamplePhaseActionError(
            "Chart edit changed ownership or instructions", step="edit_chart"
        )
    journey.chart(root, "read_edited_chart", expected)
    dashboard, dashboard_id, dashboard_path = prepare_consumers(
        journey, chart, before_dashboard, department_id
    )
    for admin in (False, True):
        usage = _model(
            ChartUsageResponse,
            journey.call(
                "GET", root + "/usage", "usage_admin" if admin else "usage_manager", admin=admin
            ),
            action.key,
        )
        wanted = {("dashboard", dashboard_id, dashboard.name)}
        if (
            {(row.kind, str(row.id), row.name) for row in usage.items} != wanted
            or len(usage.items) != len(wanted)
            or usage.pagination.total != len(wanted)
            or usage.pagination.count != len(wanted)
            or usage.pagination.offset != 0
            or usage.pagination.has_more
            or usage.has_restricted_usage
        ):
            raise SamplePhaseActionError("Chart usage visibility differs", step="usage_chart")
    blocked = journey.call("DELETE", root, "archive_in_use_chart", 409, params={"revision": 2})
    if (
        blocked.json().get("detail", {}).get("code") != "chart_in_use"
        or blocked.json().get("detail", {}).get("usage") != journey.receipts[-3]["response"]
    ):
        raise SamplePhaseActionError("In-use Chart refusal differs", step="archive_in_use_chart")
    journey.chart(root, "read_blocked_chart", expected)
    clear_consumers(journey, chart, dashboard_id, dashboard_path)
    for revision, method, suffix, step, archived in [
        (2, "DELETE", "", "archive_chart", True),
        (3, "POST", "/restore", "restore_chart", False),
        (4, "DELETE", "", "final_archive_chart", True),
    ]:
        reply = journey.call(
            method,
            root + suffix,
            step,
            204 if method == "DELETE" else 200,
            body={"revision": revision} if method == "POST" else None,
            params={"revision": revision} if method == "DELETE" else None,
            entity="charts",
            entity_id=str(chart.id),
            mutation="update",
        )
        expected.update(revision=revision + 1, is_deleted=archived)
        if reply.content:
            restored = _model(ChartResponse, reply, step)
            expected["updated_at"] = restored.model_dump(mode="json")["updated_at"]
            if restored.model_dump(mode="json") != expected:
                raise SamplePhaseActionError("Restored Chart response differs", step=step)
        current = _model(ChartResponse, journey.call("GET", root, "read_" + step), step)
        if not reply.content:
            expected["updated_at"] = current.model_dump(mode="json")["updated_at"]
        if current.model_dump(mode="json") != expected:
            raise SamplePhaseActionError("Chart lifecycle readback differs", step=step)
    final_dashboard = dispose_consumers(journey, dashboard_id, dashboard_path)
    after_dashboard = _model(
        DashboardResponse,
        journey.call(
            "GET", f"/api/dashboards/{source_dashboard}", "final_authored_dashboard", admin=True
        ),
        action.key,
    )
    if after_dashboard != before_dashboard:
        raise SamplePhaseActionError(
            "Authored Chart sources were changed", step="final_authored_sources"
        )
    if read_source_charts(journey, after_dashboard, final=True) != source_charts:
        raise SamplePhaseActionError(
            "Authored Chart instructions changed", step="final_authored_sources"
        )
    return _result(
        action,
        context,
        journey.evidence,
        journey.mappings,
        extra={
            "chart_archived": True,
            "authored_sources_preserved": True,
            "read_receipts": journey.receipts,
            "chart": current.model_dump(mode="json"),
            "dashboard": final_dashboard.model_dump(mode="json"),
            "source_dashboard_id": source_dashboard,
            "chart_id": str(chart.id),
            "dashboard_id": dashboard_id,
        },
    )
