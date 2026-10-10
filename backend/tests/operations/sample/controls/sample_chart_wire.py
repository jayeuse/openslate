"""Independent synthetic HTTP state for actual SampleClient Chart controls."""

import json
from copy import deepcopy
from uuid import NAMESPACE_URL, uuid5

import httpx

from app.systems.boards.widget_schemas import BoardWidgetWrite
from app.systems.openview.charts.schemas import ChartCreate, ChartUpdate
from app.systems.openview.dashboards.schemas import DashboardCreate, DashboardUpdate

STAMP = "2026-09-30T12:00:00Z"


def identity(label):
    return str(uuid5(NAMESPACE_URL, "independent-chart-wire:" + label))


def page(items, offset=0, limit=100):
    return {
        "items": deepcopy(items),
        "pagination": {
            "limit": limit,
            "offset": offset,
            "count": len(items),
            "total": len(items),
            "has_more": False,
        },
    }


class ChartWire:
    def __init__(self):
        self.seen, self.sequence = [], 0
        self.chart = None
        self.source_board_id, self.source_dashboard_id = (
            identity("source:board"),
            identity("source:dashboard"),
        )
        self.board_id, self.dashboard_id, self.import_id = (
            identity("copy:board"),
            identity("copy:dashboard"),
            identity("copy:import"),
        )
        self.module_id, self.department_id, self.title_id = (
            identity("module"),
            identity("department"),
            identity("field:title"),
        )
        self.query = {
            "module_id": self.module_id,
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
            "dimension": {"field_id": self.title_id, "expected_type": "text"},
            "aggregation": "count",
            "measure": None,
            "date_field": None,
            "from_date": None,
            "to_date": None,
        }
        self.boards = {self.source_board_id: self.board(self.source_board_id, "Authored source")}
        self.widgets = {
            self.source_board_id: [
                self.widget(
                    self.source_board_id,
                    "source:widget",
                    {
                        "version": 1,
                        "fields": [{"field_id": self.title_id, "expected_type": "text"}],
                        "filters": [],
                        "logic": "and",
                        "metric": None,
                        "visualization": "bar",
                        "refresh": "manual",
                    },
                    None,
                    "M",
                    False,
                )
            ]
        }
        self.dashboards = {
            self.source_dashboard_id: self.dashboard(self.source_dashboard_id, "Authored dashboard")
        }
        self.source_before = deepcopy((self.boards, self.widgets, self.dashboards))
        self.fault = None
        self.field_name, self.module_name, self.department_name = (
            "Title",
            "Fixture module",
            "Fixture department",
        )

    def board(self, key, name):
        return {
            "id": key,
            "scope": "project",
            "department_id": None,
            "name": name,
            "description": "Owned fixture",
            "status": "active",
            "revision": 1,
            "level": "manage",
            "created_at": STAMP,
            "updated_at": STAMP,
        }

    def dashboard(self, key, name):
        return {
            "id": key,
            "department_id": self.department_id,
            "name": name,
            "position": 0,
            "refresh_cadence": "manual",
            "revision": 1,
            "is_deleted": False,
            "created_at": STAMP,
            "updated_at": STAMP,
            "widgets": [],
        }

    def widget(self, board_id, tag, config, chart_id, size, pinned, position=0):
        return {
            "id": identity(tag),
            "board_id": board_id,
            "name": "Owned widget",
            "widget_type": "records" if chart_id is None else "chart",
            "module_id": self.module_id,
            "position": position,
            "size": size,
            "pinned": pinned,
            "chart_id": chart_id,
            "config": deepcopy(config),
            "created_at": STAMP,
            "updated_at": STAMP,
        }

    def usage(self, admin):
        items = []
        board_used = any(
            row["chart_id"] == self.chart["id"] for row in self.widgets.get(self.board_id, [])
        )
        dashboard_used = any(
            row["chart_id"] == self.chart["id"]
            for row in self.dashboards.get(self.dashboard_id, {}).get("widgets", [])
        )
        if board_used and admin:
            items.append(
                {"kind": "board", "id": self.board_id, "name": self.boards[self.board_id]["name"]}
            )
        if dashboard_used:
            items.append(
                {
                    "kind": "dashboard",
                    "id": self.dashboard_id,
                    "name": self.dashboards[self.dashboard_id]["name"],
                }
            )
        return {**page(items), "has_restricted_usage": board_used and not admin}

    def portable(self):
        widgets = []
        for row in self.widgets[self.board_id]:
            if row["chart_id"]:
                config = {
                    "version": 1,
                    "chart_type": "bar",
                    "size": "S",
                    "pinned": True,
                    "refresh": "manual",
                    "query": {
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
                        "dimension": {"name": self.field_name, "expected_type": "text"},
                        "aggregation": "count",
                        "measure": None,
                        "date_field": None,
                        "from_date": None,
                        "to_date": None,
                    },
                }
            else:
                config = {
                    "fields": [{"name": self.field_name, "expected_type": "text"}],
                    "filters": [],
                    "logic": "and",
                    "metric": None,
                    "visualization": "bar",
                    "size": "M",
                    "pinned": False,
                    "refresh": "manual",
                }
            widgets.append(
                {
                    "name": row["name"],
                    "widget_type": row["widget_type"],
                    "source": {
                        "department_name": self.department_name,
                        "module_name": self.module_name,
                    },
                    "config": config,
                }
            )
        return {
            "kind": "openslate-board",
            "version": 3,
            "configuration": {
                "name": self.boards[self.board_id]["name"],
                "description": "Owned fixture",
                "widgets": widgets,
            },
        }

    def __call__(self, request):
        self.sequence += 1
        headers = {
            "X-Request-ID": identity("request:" + str(self.sequence)),
            "Cache-Control": "private, no-store",
        }
        method, path = request.method, request.url.path
        if path == "/api/auth/login":
            actor = json.loads(request.content)["email"].split("@")[0]
            return httpx.Response(
                200,
                headers=[
                    *headers.items(),
                    ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
                    ("Set-Cookie", f"openslate_access={actor}; Path=/; HttpOnly"),
                ],
                json={"ok": True},
            )
        admin = "openslate_access=admin" in request.headers.get("cookie", "")
        body = (
            json.loads(request.content)
            if request.content
            and request.headers.get("content-type", "").startswith("application/json")
            else None
        )
        self.seen.append((method, path))
        if self.fault and self.fault[0] == (method, path):
            fault = self.fault[1]
            if isinstance(fault, Exception):
                raise fault
            return httpx.Response(fault, headers=headers, json={"detail": "owned fault"})

        def reply(status, value=None):
            return (
                httpx.Response(status, headers=headers, json=deepcopy(value))
                if value is not None
                else httpx.Response(status, headers=headers)
            )

        if path == "/api/charts" and method == "POST":
            parsed = ChartCreate.model_validate(body)
            assert (
                str(parsed.module_id) == self.module_id
                and parsed.query.model_dump(mode="json") == self.query
            )
            self.chart = {
                "id": identity("chart"),
                "module_id": self.module_id,
                "department_id": self.department_id,
                "name": "Owned Chart control",
                "chart_type": "bar",
                "query": deepcopy(self.query),
                "revision": 1,
                "is_deleted": False,
                "created_at": STAMP,
                "updated_at": STAMP,
            }
            headers["Location"] = "/api/charts/" + self.chart["id"]
            return reply(201, self.chart)
        if path == "/api/charts" and method == "GET":
            return reply(
                200,
                page(
                    [self.chart],
                    int(request.url.params.get("offset", 0)),
                    int(request.url.params.get("limit", 100)),
                ),
            )
        if self.chart and path.startswith("/api/charts/" + self.chart["id"]):
            if path.endswith("/usage"):
                return reply(200, self.usage(admin))
            if path.endswith("/restore"):
                assert body == {"revision": 3}
                self.chart.update(revision=4, is_deleted=False)
                return reply(200, self.chart)
            if method == "GET":
                return reply(200, self.chart)
            if method == "PATCH":
                parsed = ChartUpdate.model_validate(body)
                assert parsed.revision == 1 and parsed.name == "Reviewed Chart control"
                self.chart.update(name="Reviewed Chart control", revision=2)
                return reply(200, self.chart)
            if method == "DELETE":
                revision = int(request.url.params["revision"])
                assert revision == self.chart["revision"]
                usage = self.usage(admin)
                if usage["items"] or usage["has_restricted_usage"]:
                    return reply(
                        409,
                        {
                            "detail": {
                                "code": "chart_in_use",
                                "message": "Chart is in use",
                                "usage": usage,
                            }
                        },
                    )
                self.chart.update(is_deleted=True, revision=revision + 1)
                return reply(204)
        if path == "/api/dashboards" and method == "POST":
            parsed = DashboardCreate.model_validate(body)
            assert str(parsed.department_id) == self.department_id and parsed.widgets == []
            self.dashboards[self.dashboard_id] = self.dashboard(self.dashboard_id, body["name"])
            headers["Location"] = "/api/dashboards/" + self.dashboard_id
            return reply(201, self.dashboards[self.dashboard_id])
        if path.startswith("/api/dashboards/"):
            key = path.split("/")[3]
            row = self.dashboards[key]
            if method == "GET":
                return reply(200, row)
            if method == "PATCH":
                parsed = DashboardUpdate.model_validate(body)
                assert parsed.revision == row["revision"]
                row["revision"] += 1
                row["widgets"] = (
                    []
                    if not parsed.widgets
                    else [
                        {
                            "id": identity("dashboard:widget"),
                            "position": 0,
                            "widget_type": "chart",
                            "size": "S",
                            "chart_id": self.chart["id"],
                            "config": None,
                            "created_at": STAMP,
                            "updated_at": STAMP,
                        }
                    ]
                )
                return reply(200, row)
            if method == "DELETE":
                assert request.url.params["revision"] == "3" and row["widgets"] == []
                row.update(revision=4, is_deleted=True)
                return reply(204)
        if path == "/api/boards/import":
            assert json.loads(request.content) == self.portable()
            self.boards[self.import_id] = self.board(self.import_id, "Imported owned Board")
            self.widgets[self.import_id] = deepcopy(self.widgets[self.board_id])
            for index, row in enumerate(self.widgets[self.import_id]):
                row.update(id=identity("import:widget:" + str(index)), board_id=self.import_id)
                if row["chart_id"]:
                    row.update(
                        chart_id=None,
                        config={"version": 1, "chart_type": "bar", "query": deepcopy(self.query)},
                    )
            headers["Location"] = "/api/boards/" + self.import_id
            return reply(201, self.boards[self.import_id])
        if path.startswith("/api/boards/"):
            key = path.split("/")[3]
            if path.endswith("/duplicate"):
                assert key == self.source_board_id and admin
                self.boards[self.board_id] = self.board(self.board_id, "Private copied Board")
                self.widgets[self.board_id] = deepcopy(self.widgets[self.source_board_id])
                self.widgets[self.board_id][0].update(
                    id=identity("copy:widget"), board_id=self.board_id
                )
                headers["Location"] = "/api/boards/" + self.board_id
                return reply(201, self.boards[self.board_id])
            if key not in self.boards:
                return reply(404, {"detail": "Board not found"})
            row = self.boards[key]
            if path.endswith("/configuration"):
                headers["Content-Disposition"] = 'attachment; filename="board-configuration.json"'
                return reply(200, self.portable())
            if "/widgets" in path:
                if method == "GET":
                    return reply(
                        200, {**page(self.widgets[key]), "board_revision": row["revision"]}
                    )
                if method == "POST":
                    parsed = BoardWidgetWrite.model_validate(body)
                    assert (
                        parsed.revision == row["revision"]
                        and parsed.widget.config is None
                        and parsed.widget.size == "S"
                        and parsed.widget.pinned
                    )
                    added = self.widget(key, "copy:reference", None, self.chart["id"], "S", True, 1)
                    added["name"] = "Chart control reference"
                    self.widgets[key].append(added)
                    row["revision"] += 1
                    return reply(201, {"widget": added, "board_revision": row["revision"]})
                if method == "DELETE":
                    # The router reads the Board revision from the query, like the frontend.
                    assert body is None
                    assert int(request.url.params["revision"]) == row["revision"]
                    self.widgets[key] = [
                        item for item in self.widgets[key] if item["id"] != path.split("/")[-1]
                    ]
                    row["revision"] += 1
                    return reply(204)
            if path.endswith("/archive"):
                assert body == {"revision": row["revision"]}
                row.update(status="archived", revision=row["revision"] + 1)
                return reply(200, row)
            if path.endswith("/purge/preview"):
                return reply(
                    200,
                    {
                        "token": "fixture-token",
                        "confirmation_name": row["name"],
                        "impact": {"target_id": key, "operation": "purge"},
                    },
                )
            if path.endswith("/purge"):
                assert (
                    body["password"] == "fixture-password"
                    and body["token"] == "fixture-token"
                    and row["status"] == "archived"
                )
                del self.boards[key]
                del self.widgets[key]
                return reply(200, {"impact": {"target_id": key, "operation": "purge"}})
            if method == "GET":
                return reply(200, row)
        raise AssertionError(f"Unexpected independent wire request: {method} {path}")
