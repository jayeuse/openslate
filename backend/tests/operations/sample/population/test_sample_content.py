"""HTTP-level contracts for audited Board content population helpers."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.systems.boards.widget_schemas import BoardWidgetWrite
from operations.sample.client import SampleClient
from operations.sample.packs.registry import get_pack
from operations.sample.population.board_entries import create_board_event, create_board_post
from operations.sample.population.boards import _make_widgets, replace_project_board_groups
from operations.sample.population.content import (
    SampleContentError,
    assert_empty_content,
    verify_content,
)

ORIGIN = "https://workspace.example.test"
BASE_URL = "https://api.example.test"
CSRF = "sample-csrf-cookie"
BOARD_ID = "00000000-0000-7000-8000-000000000001"
DEPARTMENT_ID = "00000000-0000-7000-8000-000000000002"
POST_ID = "00000000-0000-7000-8000-000000000003"
EVENT_ID = "00000000-0000-7000-8000-000000000004"
ACTOR_ID = "00000000-0000-7000-8000-000000000005"
NOW = datetime(2026, 9, 29, tzinfo=UTC).isoformat().replace("+00:00", "Z")


def _client(tmp_path: Path, handler: Any) -> SampleClient:
    return SampleClient(
        BASE_URL,
        ORIGIN,
        tmp_path / "private" / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    )


def _login(request: httpx.Request) -> httpx.Response:
    assert request.url.path == "/api/auth/login"
    return httpx.Response(
        200,
        json={"authenticated": True, "setup_required": False},
        headers=[
            ("set-cookie", "openslate_access=sample-access; Path=/; HttpOnly"),
            ("set-cookie", "openslate_refresh=sample-refresh; Path=/api/auth; HttpOnly"),
            ("set-cookie", f"openslate_csrf={CSRF}; Path=/"),
        ],
    )


def test_empty_guard_pages_archived_posts_and_rejects_partial_baseline(
    tmp_path: Path,
) -> None:
    company = {
        "id": BOARD_ID,
        "scope": "company",
        "department_id": None,
        "name": "Company",
        "description": None,
        "status": "active",
        "revision": 1,
        "level": "manage",
        "created_at": NOW,
        "updated_at": NOW,
    }
    seen: list[httpx.Request] = []

    def empty_page(
        offset: int, *, total: int = 0, items: list[Any] | None = None
    ) -> dict[str, Any]:
        rows = items or []
        return {
            "items": rows,
            "pagination": {
                "limit": 100,
                "offset": offset,
                "count": len(rows),
                "total": total,
                "has_more": offset + len(rows) < total,
            },
        }

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/auth/login":
            return _login(request)
        if request.url.path == "/api/boards":
            return httpx.Response(200, json=empty_page(0, total=1, items=[company]))
        if request.url.path == f"/api/boards/{BOARD_ID}/posts":
            query = dict(request.url.params)
            if query["view"] == "archive" and query["offset"] == "0":
                return httpx.Response(200, json=empty_page(0, total=1))
            if query["view"] == "archive":
                archived = {"id": POST_ID, "status": "archived"}
                return httpx.Response(200, json=empty_page(100, total=1, items=[archived]))
            return httpx.Response(200, json=empty_page(0))
        return httpx.Response(200, json=empty_page(0))

    with _client(tmp_path, handler) as client:
        assert client.login("sample@example.test", "synthetic-password").status_code == 200
        with pytest.raises(SampleContentError, match="(?i)existing content"):
            assert_empty_content(client, [company])

    archived_pages = [
        request
        for request in seen
        if request.url.path == f"/api/boards/{BOARD_ID}/posts"
        and dict(request.url.params).get("view") == "archive"
    ]
    assert [dict(request.url.params)["offset"] for request in archived_pages] == ["0", "100"]
    assert all(request.method == "GET" for request in seen[1:])


def test_project_board_access_uses_admin_revisioned_group_replace(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []
    operation_group = "00000000-0000-7000-8000-000000000011"
    guest_group = "00000000-0000-7000-8000-000000000012"
    finance_group = "00000000-0000-7000-8000-000000000013"

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/auth/login":
            return _login(request)
        if request.method == "GET" and request.url.path.endswith("/groups"):
            return httpx.Response(200, json={"board_id": BOARD_ID, "revision": 4, "groups": []})
        if request.method == "PUT" and request.url.path.endswith("/groups"):
            payload = json.loads(request.content)
            assert payload["revision"] == 4
            assert {(row["group_id"], row["level"]) for row in payload["groups"]} == {
                (operation_group, "write"),
                (guest_group, "read"),
                (finance_group, "write"),
            }
            return httpx.Response(
                200,
                json={
                    "board_id": BOARD_ID,
                    "revision": 5,
                    "groups": [],
                },
            )
        raise AssertionError(f"Unexpected fixture request: {request.method} {request.url.path}")

    with _client(tmp_path, handler) as client:
        assert client.login("sample@example.test", "synthetic-password").status_code == 200
        result = replace_project_board_groups(
            client,
            BOARD_ID,
            "finance",
            {
                "harbor-operations": operation_group,
                "guest-readers": guest_group,
                "finance-review": finance_group,
            },
        )

    assert result["revision"] == 5
    assert [(request.method, request.url.path) for request in seen[1:]] == [
        ("GET", f"/api/boards/{BOARD_ID}/groups"),
        ("PUT", f"/api/boards/{BOARD_ID}/groups"),
    ]


@pytest.mark.parametrize("with_numeric", [True, False])
def test_board_population_writes_standalone_widget_presentation(
    tmp_path: Path, with_numeric: bool
) -> None:
    module_id = "00000000-0000-7000-8000-000000000020"
    title_id = "00000000-0000-7000-8000-000000000021"
    amount_id = "00000000-0000-7000-8000-000000000022"
    refs = [
        {"field_id": title_id, "expected_type": "text"},
        {"field_id": amount_id, "expected_type": "number"},
    ]
    if not with_numeric:
        refs = refs[:1]
    expected = (
        ("summary", "Operations snapshot", "M", None, "count", "bar"),
        ("workload", "Status breakdown", "M", None, "count", "bar"),
        ("records", "Recent records", "L", None, "count", "bar"),
        (
            "chart",
            "Trend chart",
            "M",
            refs[1] if with_numeric else None,
            "sum" if with_numeric else "count",
            "line",
        ),
    )
    revision = 7
    saved: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal revision
        if request.url.path == "/api/auth/login":
            return _login(request)
        if request.method == "GET":
            assert request.url.path == f"/api/boards/{BOARD_ID}"
            return httpx.Response(200, json={"id": BOARD_ID, "revision": revision})
        assert (request.method, request.url.path) == ("POST", f"/api/boards/{BOARD_ID}/widgets")
        BoardWidgetWrite.model_validate_json(request.content, strict=True)
        kind, name, size, metric, aggregation, visualization = expected[len(saved)]
        wanted = {
            "name": name,
            "widget_type": kind,
            "module_id": module_id,
            "size": size,
            "pinned": False,
            "chart_id": None,
            "config": {
                "version": 1,
                "fields": refs,
                "filters": [],
                "logic": "and",
                "aggregation": aggregation,
                "metric": metric,
                "visualization": visualization,
                "refresh": "manual",
            },
        }
        assert json.loads(request.content) == {"revision": revision, "widget": wanted}
        widget = {
            **wanted,
            "id": f"00000000-0000-7000-8000-{31 + len(saved):012d}",
            "board_id": BOARD_ID,
            "position": len(saved),
            "created_at": NOW,
            "updated_at": NOW,
        }
        saved.append(widget)
        revision += 1
        return httpx.Response(
            201,
            headers={"X-Request-ID": widget["id"]},
            json={"widget": widget, "board_revision": revision},
        )

    with _client(tmp_path, handler) as client:
        assert client.login("sample@example.test", "synthetic-password").status_code == 200
        count = _make_widgets(
            client,
            [
                {
                    "id": BOARD_ID,
                    "logical_id": "department:finance",
                    "board": {"id": BOARD_ID},
                    "department_key": "finance",
                }
            ],
            {"finance": {"id": DEPARTMENT_ID}},
            {"fixture": {"id": module_id, "department_id": DEPARTMENT_ID}},
            {
                "fixture": [
                    {
                        "id": title_id,
                        "module_id": module_id,
                        "name": "Title",
                        "type": "text",
                        "position": 0,
                    },
                    {
                        "id": amount_id,
                        "module_id": module_id,
                        "name": "Amount",
                        "type": "number",
                        "position": 1,
                    },
                ][: 2 if with_numeric else 1]
            },
            get_pack("harbor"),
        )
    assert count == 4 and revision == 11
    assert [widget["size"] for widget in saved] == ["M", "M", "L", "M"]
    assert all(widget["chart_id"] is None and widget["pinned"] is False for widget in saved)


def test_board_post_and_event_use_current_revision_and_ui_payloads(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []
    revision = 4

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal revision
        seen.append(request)
        if request.url.path == "/api/auth/login":
            return _login(request)
        if request.method == "GET" and request.url.path == f"/api/boards/{BOARD_ID}":
            return httpx.Response(200, json={"id": BOARD_ID, "revision": revision})
        if request.method == "POST" and request.url.path.endswith("/posts"):
            assert json.loads(request.content) == {
                "board_revision": revision,
                "title": "Open service request",
                "body": "Confirm the owner and follow-up date.",
                "links": [],
                "expires_at": None,
                "pinned": False,
            }
            revision += 1
            return httpx.Response(201, json={"id": POST_ID, "board_revision": revision})
        if request.method == "POST" and request.url.path.endswith("/events"):
            body = json.loads(request.content)
            assert body == {
                "board_revision": revision,
                "title": "Service response checkpoint",
                "details": "Review the open commitment.",
                "location": "Makati Operations Center",
                "links": [],
                "all_day": False,
                "start_at": "2026-10-12T01:00:00Z",
                "end_at": "2026-10-12T02:00:00Z",
                "timezone_name": "Asia/Manila",
                "recurrence": "none",
                "repeat_until": None,
                "reminders": ["15m"],
            }
            return httpx.Response(201, json={"id": EVENT_ID, "board_revision": revision + 1})
        raise AssertionError(f"Unexpected fixture request: {request.method} {request.url.path}")

    event = {
        "title": "Service response checkpoint",
        "details": "Review the open commitment.",
        "location": "Makati Operations Center",
        "links": [],
        "all_day": False,
        "start_at": "2026-10-12T01:00:00Z",
        "end_at": "2026-10-12T02:00:00Z",
        "timezone_name": "Asia/Manila",
        "recurrence": "none",
        "repeat_until": None,
        "reminders": ["15m"],
    }
    with _client(tmp_path, handler) as client:
        assert client.login("sample@example.test", "synthetic-password").status_code == 200
        post = create_board_post(
            client, BOARD_ID, "Open service request", "Confirm the owner and follow-up date."
        )
        saved_event = create_board_event(client, BOARD_ID, event)

    assert post["board_revision"] == 5
    assert saved_event["id"] == EVENT_ID
    assert [(request.method, request.url.path) for request in seen[1:]] == [
        ("GET", f"/api/boards/{BOARD_ID}"),
        ("POST", f"/api/boards/{BOARD_ID}/posts"),
        ("GET", f"/api/boards/{BOARD_ID}"),
        ("POST", f"/api/boards/{BOARD_ID}/events"),
    ]


def test_content_verify_combines_partial_failures_and_requires_saved_report_outputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from operations.sample.population import board_files as sample_board_files
    from operations.sample.population import boards as sample_boards
    from operations.sample.population import openview as sample_openview

    monkeypatch.setattr(
        sample_boards,
        "verify_boards",
        lambda _admin, *, mappings, organization=None: {"boards": 1, "read_failures": 2},
    )
    monkeypatch.setattr(
        sample_board_files,
        "verify_seeded_attachments",
        lambda _admin, *, mappings, organization=None: (6, ["download differs"]),
    )
    monkeypatch.setattr(
        sample_openview,
        "verify_openview",
        lambda _admin, *, mappings, organization=None: {
            "reports": 2,
            "report_runs": 2,
            "report_outputs": 1,
            "read_failures": 3,
        },
    )
    with _client(
        tmp_path, lambda _request: pytest.fail("verification should use the stubs")
    ) as client:
        result = verify_content(
            client,
            run_manifest={"expected": {"boards": 1, "reports": 2, "report_runs": 2}},
            mappings={},
        )

    assert result["read_failures"] == 6
    assert (result["attachment_downloads"], result["attachment_download_failures"]) == (6, 1)
    assert result["missing_report_outputs"] == 1
    assert result["content_complete"] == 0
