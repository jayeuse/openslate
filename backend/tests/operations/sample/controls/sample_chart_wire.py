"""Independent synthetic HTTP state for actual SampleClient Chart controls."""

import json
from copy import deepcopy
from uuid import NAMESPACE_URL, uuid5

import httpx

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
        self.source_dashboard_id = identity("source:dashboard")
        self.dashboard_id = identity("copy:dashboard")
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
        self.dashboards = {
            self.source_dashboard_id: self.dashboard(self.source_dashboard_id, "Authored dashboard")
        }
        self.source_before = deepcopy(self.dashboards)
        self.fault = None

    def dashboard(self, key, name):
        return {
            "id": key,
            "department_id": self.department_id,
            "name": name,
            "position": 0,
            "refresh_cadence": "manual",
            "revision": 1,
            "is_home": False,
            "is_deleted": False,
            "created_at": STAMP,
            "updated_at": STAMP,
            "widgets": [],
        }

    def usage(self):
        items = []
        dashboard_used = any(
            row["chart_id"] == self.chart["id"]
            for row in self.dashboards.get(self.dashboard_id, {}).get("widgets", [])
        )
        if dashboard_used:
            items.append(
                {
                    "kind": "dashboard",
                    "id": self.dashboard_id,
                    "name": self.dashboards[self.dashboard_id]["name"],
                }
            )
        return {**page(items), "has_restricted_usage": False}

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
        body = json.loads(request.content) if request.content else None
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
                return reply(200, self.usage())
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
                usage = self.usage()
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
                            **parsed.widgets[-1].model_dump(
                                include={"grid_column", "grid_row", "column_span", "row_span"}
                            ),
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
        raise AssertionError(f"Unexpected independent wire request: {method} {path}")
