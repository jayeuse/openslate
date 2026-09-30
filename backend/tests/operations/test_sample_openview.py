"""UI-payload coverage for shared OpenView sample content."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

from operations.sample_client import SampleClient
from operations.sample_openview import populate_openview

ORIGIN = "https://workspace.example.test"
BASE_URL = "https://api.example.test"


def test_openview_population_uses_ui_routes_and_captures_disabled_schedule_runs(
    tmp_path: Path,
) -> None:
    departments: dict[str, dict[str, str]] = {}
    modules: dict[str, dict[str, str]] = {}
    fields: dict[str, list[dict[str, Any]]] = {}
    keys = ("sales", "service", "field", "inventory", "purchasing", "finance")
    for department_key in keys:
        department_id = str(uuid4())
        departments[department_key] = {"id": department_id, "name": department_key.title()}
        for index in range(4):
            module_key = f"{department_key}_module_{index}"
            module_id = str(uuid4())
            modules[module_key] = {"id": module_id, "department_id": department_id}
            fields[module_key] = [
                {
                    "id": str(uuid4()),
                    "module_id": module_id,
                    "name": "Title",
                    "type": "text",
                    "position": 0,
                },
                {
                    "id": str(uuid4()),
                    "module_id": module_id,
                    "name": "Status",
                    "type": "select",
                    "position": 1,
                },
                {
                    "id": str(uuid4()),
                    "module_id": module_id,
                    "name": "Created",
                    "type": "date",
                    "position": 2,
                },
                {
                    "id": str(uuid4()),
                    "module_id": module_id,
                    "name": "Due",
                    "type": "datetime",
                    "position": 3,
                },
                {
                    "id": str(uuid4()),
                    "module_id": module_id,
                    "name": "Amount",
                    "type": "number",
                    "position": 4,
                },
            ]

    seen: list[httpx.Request] = []
    created_id = 0

    def next_id() -> str:
        nonlocal created_id
        created_id += 1
        return str(uuid4())

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                json={"authenticated": True, "setup_required": False},
                headers=[
                    ("set-cookie", "openslate_access=sample-access; Path=/; HttpOnly"),
                    ("set-cookie", "openslate_refresh=sample-refresh; Path=/api/auth; HttpOnly"),
                    ("set-cookie", "openslate_csrf=sample-csrf; Path=/"),
                ],
            )
        assert request.headers["origin"] == ORIGIN
        body = json.loads(request.content) if request.content else {}
        if request.method == "POST" and request.url.path == "/api/views":
            return httpx.Response(201, json={"id": next_id(), "module_id": body["module_id"]})
        if request.method == "POST" and request.url.path == "/api/dashboards":
            widgets = [
                {"id": next_id(), "position": position}
                for position, _ in enumerate(body["widgets"])
            ]
            return httpx.Response(201, json={"id": next_id(), "widgets": widgets})
        if request.method == "POST" and request.url.path == "/api/reports":
            return httpx.Response(201, json={"id": next_id(), "module_id": body["module_id"]})
        if request.method == "POST" and request.url.path.endswith("/runs"):
            report_id = request.url.path.split("/")[3]
            return httpx.Response(
                201,
                json={
                    "id": next_id(),
                    "report_id": report_id,
                    "row_count": 3,
                    "headings": ["Title"],
                    "created_at": "2026-09-29T00:00:00Z",
                },
            )
        if request.method == "POST" and request.url.path.endswith("/schedule"):
            return httpx.Response(
                201,
                json={
                    "id": next_id(),
                    "report_id": request.url.path.split("/")[3],
                    "enabled": False,
                },
            )
        raise AssertionError(f"Unexpected fixture request: {request.method} {request.url.path}")

    client = SampleClient(
        BASE_URL,
        ORIGIN,
        tmp_path / "private" / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    )
    with client:
        assert client.login("sample@example.test", "synthetic-password").status_code == 200
        counts = populate_openview(
            client,
            departments=departments,
            modules=modules,
            fields=fields,
            anchor_date=date(2026, 9, 29),
            seed=42,
        )

    view_bodies = [
        json.loads(request.content)
        for request in seen
        if request.method == "POST" and request.url.path == "/api/views"
    ]
    dashboard_bodies = [
        json.loads(request.content)
        for request in seen
        if request.method == "POST" and request.url.path == "/api/dashboards"
    ]
    report_bodies = [
        json.loads(request.content)
        for request in seen
        if request.method == "POST" and request.url.path == "/api/reports"
    ]
    run_requests = [request for request in seen if request.url.path.endswith("/runs")]
    schedule_bodies = [
        json.loads(request.content) for request in seen if request.url.path.endswith("/schedule")
    ]

    assert counts == {
        "views": 36,
        "dashboards": 6,
        "dashboard_widgets": 24,
        "reports": 12,
        "report_runs": 12,
        "schedules": 12,
        "disabled_schedules": 12,
    }
    assert len(view_bodies) == 36
    assert {body["presentation"]["layout"] for body in view_bodies} == {
        "table",
        "grid",
        "kanban",
        "calendar",
        "timeline",
        "gallery",
    }
    assert all(body["definition"]["columns"] for body in view_bodies)
    assert all(len(body["widgets"]) == 4 for body in dashboard_bodies)
    assert len(report_bodies) == len(run_requests) == len(schedule_bodies) == 12
    assert len({request.headers["idempotency-key"] for request in run_requests}) == 12
    assert {body["cadence"] for body in schedule_bodies} == {"daily", "weekly"}
    assert all(body["enabled"] is False for body in schedule_bodies)
