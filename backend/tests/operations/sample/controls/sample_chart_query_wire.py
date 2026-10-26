"""Independent rich authored-widget states and portable name/label expectations."""

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
    dataset, action, context, original, directory = setup
    wire = RichChartWire()
    wire.field_name, wire.module_name, wire.department_name = (
        original.field_name,
        original.module_name,
        original.department_name,
    )
    for client in context.clients.values():
        client._client._transport = httpx.MockTransport(wire)
    return dataset, action, context, wire, directory


def rich_queries(module_id):
    title = {"field_id": identity("rich:title"), "expected_type": "text"}
    amount = {"field_id": identity("rich:amount"), "expected_type": "number"}
    status = {"field_id": identity("rich:status"), "expected_type": "select"}
    date = {"field_id": identity("rich:date"), "expected_type": "date"}
    owner = {"field_id": identity("rich:owner"), "expected_type": "user"}
    named_title = {"name": "Title", "expected_type": "text"}
    named_amount = {"name": "Amount", "expected_type": "number"}
    named_status = {"name": "Status", "expected_type": "select"}
    named_date = {"name": "Occurred", "expected_type": "date"}
    named_owner = {"name": "Owner", "expected_type": "user"}
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
    portable_definition = {
        "version": 1,
        "columns": [named_title, named_amount, named_status, named_date],
        "filters": [
            {**named_status, "operator": "in", "value": ["Active", "Open"]},
            {**named_owner, "operator": "empty", "value": None},
            {**named_owner, "operator": "not_empty", "value": None},
            *[
                {**named_title, "operator": "contains", "value": value}
                for value in ["North", "East", "West", "South", "Coast", "Hill", "Port"]
            ],
        ],
        "logic": "or",
        "sort": [{**named_amount, "direction": "desc"}, {**named_title, "direction": "asc"}],
        "deleted": "include",
        "search": "North",
        "search_fields": [named_title, named_status],
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
    portable = [
        {
            "mode": "groups",
            "definition": portable_definition,
            "dimension": named_status,
            "aggregation": "sum",
            "measure": named_amount,
            "date_field": named_date,
            "from_date": "2026-01-01",
            "to_date": "2026-03-31",
        },
        {
            "mode": "date_series",
            "definition": portable_definition,
            "aggregation": "count",
            "measure": None,
            "date_field": named_date,
            "from_date": "2020-01-01",
            "to_date": "2030-12-31",
            "bucket": "quarter",
        },
        {"definition": portable_definition},
    ]
    return deepcopy(live), deepcopy(portable)


class RichChartWire(ChartWire):
    def __init__(self):
        super().__init__()
        live, self.portable_queries = rich_queries(self.module_id)
        configs = [
            {"version": 1, "chart_type": "bar", "query": live[0]},
            {"version": 1, "chart_type": "line", "query": live[1]},
            {"version": 1, "query": live[2]},
        ]
        self.widgets[self.source_board_id] = []
        self.dashboards[self.source_dashboard_id]["widgets"] = []
        for index, (kind, size, cells, config) in enumerate(
            zip(
                ["chart", "chart", "records"],
                ["S", "M", "L"],
                [(0, 0), (2, 0), (2, 2)],
                configs,
                strict=True,
            )
        ):
            row = self.widget(
                self.source_board_id,
                "rich:widget:" + str(index),
                config,
                None,
                size,
                index != 1,
                index,
            )
            row.update(name="Rich source " + str(index), widget_type=kind)
            self.widgets[self.source_board_id].append(row)
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
        self.source_before = deepcopy((self.boards, self.widgets, self.dashboards))
        self.corrupt = None
        self.source_chart = {
            "id": identity("rich:source:chart"),
            "module_id": self.module_id,
            "department_id": self.department_id,
            "name": "Authored records instructions",
            "chart_type": "records",
            "query": live[2],
            "revision": 7,
            "is_deleted": False,
            "created_at": STAMP,
            "updated_at": STAMP,
        }

    def add_reference_source(self):
        row = self.widget(
            self.source_board_id, "rich:source:ref", None, self.source_chart["id"], "L", False, 3
        )
        row.update(name="Authored reference", widget_type="records")
        self.widgets[self.source_board_id].append(row)
        self.source_before = deepcopy((self.boards, self.widgets, self.dashboards))

    def portable(self):
        bundle = super().portable()
        for index, query in enumerate(self.portable_queries):
            row = bundle["configuration"]["widgets"][index]
            row["config"] = {
                "version": 1,
                "query": deepcopy(query),
                "size": ["S", "M", "L"][index],
                "pinned": index != 1,
                "refresh": "manual",
                **({"chart_type": ["bar", "line"][index]} if index < 2 else {}),
            }
        if len(self.widgets[self.source_board_id]) == 4:
            bundle["configuration"]["widgets"][3]["config"] = {
                "version": 1,
                "query": deepcopy(self.portable_queries[2]),
                "size": "L",
                "pinned": False,
                "refresh": "manual",
            }
        return bundle

    def __call__(self, request):
        method, path = request.method, request.url.path
        if path == "/api/charts/" + self.source_chart["id"] and method == "GET":
            self.sequence += 1
            self.seen.append((method, path))
            return httpx.Response(
                200,
                headers={"X-Request-ID": identity("request:" + str(self.sequence))},
                json=deepcopy(self.source_chart),
            )
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
        response = super().__call__(request)
        if path.endswith("/duplicate"):
            for index, row in enumerate(self.widgets[self.board_id]):
                row.update(id=identity("rich:copy:board:" + str(index)), board_id=self.board_id)
            if self.corrupt == "board_copy":
                self.widgets[self.board_id][0]["pinned"] = False
        if path == "/api/boards/import" and self.corrupt == "import_source":
            self.widgets[self.import_id][0]["config"]["query"]["aggregation"] = "average"
        if path == "/api/boards/import" and len(self.widgets[self.source_board_id]) == 4:
            self.widgets[self.import_id][3]["config"] = {
                "version": 1,
                "query": deepcopy(self.source_chart["query"]),
            }
        if path == f"/api/boards/{self.board_id}/widgets" and method == "POST":
            position = len(self.widgets[self.source_board_id])
            self.widgets[self.board_id][-1]["position"] = position
            body = response.json()
            body["widget"]["position"] = position
            response = httpx.Response(response.status_code, headers=response.headers, json=body)
        return response
