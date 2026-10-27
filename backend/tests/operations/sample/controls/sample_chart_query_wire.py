"""Independent rich authored Dashboard states and reply/receipt corruption helpers."""

import json
from copy import deepcopy

import httpx

from app.systems.openview.dashboards.schemas import DashboardCreate, DashboardUpdate
from tests.operations.sample.controls.sample_chart_wire import STAMP, ChartWire, identity

PLACEMENT = ("grid_column", "grid_row", "column_span", "row_span")
APPENDED = {"grid_column": 0, "grid_row": 3, "column_span": 2, "row_span": 2}


def boundary_reply_fault(wire, fault):
    original = wire.__call__

    def corrupt(request):
        response = original(request)
        path = request.url.path
        body = response.json() if response.content else None
        if (
            fault
            and fault.startswith("populated")
            and request.method == "GET"
            and (path == f"/api/dashboards/{wire.dashboard_id}" and body["revision"] == 2)
        ):
            if fault == "populated_name":
                body["name"] = "Unrelated current Dashboard"
            else:
                body["widgets"][-1]["column_span"] = 4
        elif fault in {"manager_name", "admin_name"} and (
            path.endswith("/usage") or response.status_code == 409
        ):
            admin = "openslate_access=admin" in request.headers.get("cookie", "")
            usage = body["detail"]["usage"] if response.status_code == 409 else body
            if admin == (fault == "admin_name") and usage["items"]:
                usage["items"][0]["name"] = "Hidden Board name sentinel"
        elif fault == "blocked_name" and response.status_code == 409:
            body["detail"]["usage"]["items"][0]["name"] = "Hidden Board name sentinel"
        elif fault and fault.startswith("restore") and path.endswith("/restore"):
            field = fault.removeprefix("restore_")
            if field == "query":
                body["query"]["definition"]["deleted"] = "only"
            else:
                body[{"state": "is_deleted", "type": "chart_type"}.get(field, field)] = {
                    "name": "Wrong restored name",
                    "revision": 9,
                    "state": True,
                    "type": "pie",
                }[field]
        return (
            httpx.Response(response.status_code, headers=response.headers, json=body)
            if body is not None
            else response
        )

    return corrupt


def corrupt_boundary_receipts(result, fault):
    if fault.startswith("list_"):
        listed = [row for row in result["read_receipts"] if row["step"].startswith("list_chart_")]
        if fault == "list_missing":
            result["read_receipts"] = [row for row in result["read_receipts"] if row not in listed]
        elif fault == "list_gap":
            listed[0]["step"] = "list_chart_1"
        elif fault == "list_query":
            listed[0]["response"]["items"][0]["query"]["definition"]["deleted"] = "only"
        elif fault == "list_params":
            listed[0]["params"]["offset"] = 99
        else:
            listed[0]["response"]["pagination"]["total"] = 2
    else:
        for row in result["read_receipts"]:
            if fault == "usage_name" and row["step"] == "usage_manager":
                row["response"]["items"][0]["name"] = "Hidden Board name sentinel"
            elif fault == "restore_response" and row["step"] == "restore_chart":
                row["response"]["name"] = "Wrong restored name"
        if fault == "usage_name":
            blocked = next(
                row for row in result["read_receipts"] if row["step"] == "archive_in_use_chart"
            )
            blocked["response"]["detail"]["usage"]["items"][0]["name"] = (
                "Hidden Board name sentinel"
            )


def rich_setup(setup):
    dataset, action, context, _, directory = setup
    wire = RichChartWire()
    for client in context.clients.values():
        client._client._transport = httpx.MockTransport(wire)
    return dataset, action, context, wire, directory


def rich_queries(module_id):
    title = {"field_id": identity("rich:title"), "expected_type": "text"}
    amount = {"field_id": identity("rich:amount"), "expected_type": "number"}
    status = {"field_id": identity("rich:status"), "expected_type": "select"}
    date = {"field_id": identity("rich:date"), "expected_type": "date"}
    owner = {"field_id": identity("rich:owner"), "expected_type": "user"}
    definition = {
        "version": 1,
        "columns": [title, amount, status, date],
        "filters": [
            {
                **status,
                "operator": "in",
                "value": [identity("option:active"), identity("option:open")],
            },
            {**owner, "operator": "empty", "value": None},
            {**owner, "operator": "not_empty", "value": None},
            *[
                {**title, "operator": "contains", "value": value}
                for value in ["North", "East", "West", "South", "Coast", "Hill", "Port"]
            ],
        ],
        "logic": "or",
        "sort": [{**amount, "direction": "desc"}, {**title, "direction": "asc"}],
        "deleted": "include",
        "search": "North",
        "search_fields": [title, status],
    }
    live = [
        {
            "module_id": module_id,
            "mode": "groups",
            "definition": definition,
            "dimension": status,
            "aggregation": "sum",
            "measure": amount,
            "date_field": date,
            "from_date": "2026-01-01",
            "to_date": "2026-03-31",
        },
        {
            "module_id": module_id,
            "mode": "date_series",
            "definition": definition,
            "aggregation": "count",
            "measure": None,
            "date_field": date,
            "from_date": "2020-01-01",
            "to_date": "2030-12-31",
            "bucket": "quarter",
        },
        {"module_id": module_id, "definition": definition},
    ]
    return deepcopy(live)


class RichChartWire(ChartWire):
    def __init__(self):
        super().__init__()
        live = rich_queries(self.module_id)
        configs = [
            {"version": 1, "chart_type": "bar", "query": live[0]},
            {"version": 1, "chart_type": "line", "query": live[1]},
            {"version": 1, "query": live[2]},
        ]
        self.dashboards[self.source_dashboard_id]["widgets"] = []
        for index, (kind, cells, config) in enumerate(
            zip(["chart", "chart", "records"], [(0, 0), (2, 0), (2, 2)], configs, strict=True)
        ):
            self.dashboards[self.source_dashboard_id]["widgets"].append(
                {
                    "id": identity("rich:dashboard:" + str(index)),
                    "position": index,
                    "widget_type": kind,
                    **dict(zip(PLACEMENT, (*cells, 2, 2), strict=True)),
                    "chart_id": None,
                    "config": deepcopy(config),
                    "created_at": STAMP,
                    "updated_at": STAMP,
                }
            )
        self.source_before = deepcopy(self.dashboards)
        self.corrupt = None

    def __call__(self, request):
        method, path = request.method, request.url.path
        if (path == "/api/dashboards" and method == "POST") or (
            path == "/api/dashboards/" + self.dashboard_id and method == "PATCH"
        ):
            self.sequence += 1
            self.seen.append((method, path))
            body = json.loads(request.content)
            source = self.dashboards[self.source_dashboard_id]
            specs = [
                {key: row[key] for key in ("widget_type", *PLACEMENT, "chart_id", "config")}
                for row in source["widgets"]
            ]
            if method == "POST":
                DashboardCreate.model_validate(body)
                assert body["widgets"] == specs
                row = self.dashboard(self.dashboard_id, "Owned Chart control dashboard")
                row["widgets"] = deepcopy(source["widgets"])
                for index, widget in enumerate(row["widgets"]):
                    widget["id"] = identity("rich:copy:dashboard:" + str(index))
                self.dashboards[self.dashboard_id] = row
                status = 201
            else:
                DashboardUpdate.model_validate(body)
                row = self.dashboards[self.dashboard_id]
                assert body["revision"] == row["revision"]
                if body["widgets"]:
                    assert body["widgets"] == [
                        *specs,
                        {
                            "widget_type": "chart",
                            **APPENDED,
                            "chart_id": self.chart["id"],
                            "config": None,
                        },
                    ]
                    row["widgets"].append(
                        {
                            "id": identity("rich:reference"),
                            "position": 3,
                            "widget_type": "chart",
                            **APPENDED,
                            "chart_id": self.chart["id"],
                            "config": None,
                            "created_at": STAMP,
                            "updated_at": STAMP,
                        }
                    )
                else:
                    row["widgets"] = []
                row["revision"] += 1
                status = 200
            response_row = deepcopy(row)
            if self.corrupt == "dashboard_copy" and method == "POST":
                response_row["widgets"][0]["column_span"] = 4
            headers = {
                "X-Request-ID": identity("request:" + str(self.sequence)),
                "Cache-Control": "private, no-store",
            }
            if method == "POST":
                headers["Location"] = "/api/dashboards/" + self.dashboard_id
            return httpx.Response(status, headers=headers, json=response_row)
        return super().__call__(request)
