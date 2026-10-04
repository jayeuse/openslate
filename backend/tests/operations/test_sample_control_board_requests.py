from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

from operations.sample.client import SampleClient
from operations.sample.controls.boards import execute_board_control, plan_board_controls
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext
from operations.sample.scenario import build_dataset

ACTOR_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"
BOARD_ID = "a36755cf-e6ed-4da7-bdee-d9154423b3fb"
POST_ID = "271570e8-4c3c-4a0b-8879-ab374a1fc9c3"
EVENT_ID = "9748c02c-7e61-483e-ae88-6674e1bbcc4f"
RECORD_ID = "7193f7eb-4f53-4f9a-a928-59387341b871"
LINK_ID = "123e0fcb-8826-497d-9553-d591481e3b28"
WIDGET_IDS = (
    "b4ad5c26-991c-4de9-955f-902c22ce388e",
    "d917973e-b6f0-42a9-96d7-18645d5f2094",
)


def _response(status: int, body: object | None = None, *, headers: dict[str, str] | None = None):
    response_headers = dict(headers or {})
    if status in {200, 201, 204}:
        response_headers["X-Request-ID"] = str(uuid4())
    if status == 204:
        return httpx.Response(status, headers=response_headers)
    return httpx.Response(status, headers=response_headers, json=body)


def _context(
    tmp_path: Path,
    actor_key: str,
    handler: Any,
    *,
    mappings: dict[str, dict[str, str]],
) -> PhaseExecutionContext:
    client = SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "board-control-requests.jsonl",
        transport=httpx.MockTransport(handler),
    )
    assert client.login("sample@example.test", "fixture-only").status_code == 200
    return PhaseExecutionContext(
        clients={actor_key: client},
        user_ids={actor_key: ACTOR_ID},
        group_ids={},
        department_ids={},
        module_ids={},
        field_ids={},
        mappings=mappings,
        admin_password="fixture-only",
    )


def _action(dataset, operation: str):
    return next(
        action for action in plan_board_controls(dataset) if action.values["operation"] == operation
    )


def test_board_patch_uses_current_revision_and_frontend_body(tmp_path: Path) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 1), organization=get_pack("harbor"))
    action = _action(dataset, "board_patch")
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                headers=[
                    ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
                    ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly"),
                ],
                json={"ok": True},
            )
        seen.append(request)
        if request.method == "GET":
            return _response(
                200, {"id": BOARD_ID, "revision": 7, "scope": "project", "status": "active"}
            )
        body = json.loads(request.content)
        return _response(200, {"id": BOARD_ID, "revision": 8, "name": body["name"]})

    context = _context(
        tmp_path,
        action.actor_key,
        handler,
        mappings={"control_boards": {"control:duplicate": BOARD_ID}},
    )

    execute_board_control(action, dataset, context)

    patch = next(request for request in seen if request.method == "PATCH")
    assert patch.url.path == f"/api/boards/{BOARD_ID}"
    assert json.loads(patch.content) == {"revision": 7, "name": action.values["name"]}


def test_post_create_uses_frontend_body_and_validates_the_draft_list(tmp_path: Path) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 1), organization=get_pack("harbor"))
    action = _action(dataset, "post_create")
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                headers=[
                    ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
                    ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly"),
                ],
                json={"ok": True},
            )
        seen.append(request)
        if request.method == "GET" and request.url.path == f"/api/boards/{BOARD_ID}":
            return _response(200, {"id": BOARD_ID, "revision": 4})
        if request.method == "POST":
            body = json.loads(request.content)
            return _response(201, {"id": POST_ID, "status": "draft", **body})
        assert request.url.path == f"/api/boards/{BOARD_ID}/posts"
        assert dict(request.url.params) == {
            "view": "draft",
            "limit": "25",
            "offset": "0",
            "sort_by": "updated_at",
            "sort_order": "desc",
        }
        return _response(200, {"items": [{"id": POST_ID}]})

    context = _context(
        tmp_path,
        action.actor_key,
        handler,
        mappings={"control_boards": {"control:duplicate": BOARD_ID}},
    )

    execute_board_control(action, dataset, context)

    create = next(request for request in seen if request.method == "POST")
    assert create.url.path == f"/api/boards/{BOARD_ID}/posts"
    assert json.loads(create.content) == {
        "board_revision": 4,
        "title": action.values["title"],
        "body": action.values["body"],
        "links": [],
        "expires_at": None,
        "pinned": False,
    }


def test_event_create_sends_the_all_day_frontend_shape(tmp_path: Path) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 1), organization=get_pack("school"))
    action = _action(dataset, "event_create")
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                headers=[
                    ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
                    ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly"),
                ],
                json={"ok": True},
            )
        seen.append(request)
        if request.method == "GET" and request.url.path == f"/api/boards/{BOARD_ID}":
            return _response(200, {"id": BOARD_ID, "revision": 5})
        if request.method == "POST":
            return _response(201, {"id": EVENT_ID, **json.loads(request.content)})
        assert request.url.path == f"/api/boards/{BOARD_ID}/events"
        assert dict(request.url.params) == {
            "limit": "25",
            "offset": "0",
            "sort_by": "created_at",
            "sort_order": "desc",
            "archived": "active",
        }
        return _response(200, {"items": [{"id": EVENT_ID}]})

    context = _context(
        tmp_path,
        action.actor_key,
        handler,
        mappings={"control_boards": {"control:duplicate": BOARD_ID}},
    )

    execute_board_control(action, dataset, context)

    create = next(request for request in seen if request.method == "POST")
    assert create.url.path == f"/api/boards/{BOARD_ID}/events"
    assert json.loads(create.content) == {
        "board_revision": 5,
        "title": action.values["title"],
        "details": action.values["details"],
        "location": action.values["location"],
        "links": [],
        "all_day": True,
        "start_date": action.values["start_date"],
        "end_date": action.values["end_date"],
        "timezone_name": action.values["timezone_name"],
        "recurrence": "none",
        "reminders": [],
    }


def test_widget_order_uses_current_board_revision_and_widget_ids(tmp_path: Path) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 1), organization=get_pack("harbor"))
    action = _action(dataset, "widget_order")
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                headers=[
                    ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
                    ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly"),
                ],
                json={"ok": True},
            )
        seen.append(request)
        if request.method == "GET":
            assert dict(request.url.params) == {
                "limit": "100",
                "offset": "0",
                "sort_by": "position",
                "sort_order": "asc",
            }
            return _response(
                200,
                {"board_revision": 9, "items": [{"id": value} for value in WIDGET_IDS]},
            )
        body = json.loads(request.content)
        assert body == {"revision": 9, "widget_ids": list(reversed(WIDGET_IDS))}
        return _response(200, {"items": [{"id": value} for value in body["widget_ids"]]})

    context = _context(
        tmp_path,
        action.actor_key,
        handler,
        mappings={"control_boards": {"control:duplicate": BOARD_ID}},
    )

    execute_board_control(action, dataset, context)

    order = next(request for request in seen if request.method == "PUT")
    assert order.url.path == f"/api/boards/{BOARD_ID}/widgets/order"


def test_board_import_uses_exported_bundle_bytes_and_octet_stream(tmp_path: Path) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 1), organization=get_pack("harbor"))
    action = _action(dataset, "board_import")
    bundle = json.dumps(
        {"kind": "openslate-board", "version": 3, "configuration": {"name": "Pack Board"}}
    ).encode()
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                headers=[
                    ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
                    ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly"),
                ],
                json={"ok": True},
            )
        seen.append(request)
        if request.method == "GET":
            return httpx.Response(
                200,
                content=bundle,
                headers={
                    "Content-Type": "application/json",
                    "Content-Disposition": 'attachment; filename="board-configuration.json"',
                },
            )
        return _response(201, {"id": BOARD_ID, "scope": "project", "status": "active"})

    context = _context(
        tmp_path,
        action.actor_key,
        handler,
        mappings={
            "boards": {action.values["source_board_key"]: "a184b460-6f2b-4b5e-a15d-039056da1832"}
        },
    )

    execute_board_control(action, dataset, context)

    imported = next(request for request in seen if request.method == "POST")
    assert imported.url.path == "/api/boards/import"
    assert imported.headers["Content-Type"] == "application/octet-stream"
    assert imported.content == bundle


def test_event_record_link_create_and_delete_use_frontend_revision_shapes(
    tmp_path: Path,
) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 1), organization=get_pack("school"))
    create_action = _action(dataset, "event_record_link_create")
    delete_action = _action(dataset, "event_record_link_delete")
    events_path = f"/api/boards/{BOARD_ID}/events/{EVENT_ID}"
    links_path = f"{events_path}/record-links"
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                headers=[
                    ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
                    ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly"),
                ],
                json={"ok": True},
            )
        seen.append(request)
        if request.method == "GET" and request.url.path == f"/api/boards/{BOARD_ID}":
            return _response(200, {"id": BOARD_ID, "revision": 6})
        if request.method == "GET" and request.url.path == events_path:
            return _response(200, {"id": EVENT_ID, "board_id": BOARD_ID, "revision": 3})
        if request.method == "POST" and request.url.path == links_path:
            return _response(
                201,
                {"id": LINK_ID, "record_id": RECORD_ID, "available": True},
            )
        if request.method == "GET" and request.url.path == links_path:
            assert dict(request.url.params) == {"limit": "20", "offset": "0"}
            return _response(200, {"items": [{"id": LINK_ID}]})
        if request.method == "DELETE" and request.url.path == f"{links_path}/{LINK_ID}":
            return _response(204)
        raise AssertionError(f"Unexpected request: {request.method} {request.url.path}")

    mappings = {
        "control_boards": {"control:duplicate": BOARD_ID},
        "control_events": {"control:event": EVENT_ID},
        "record": {str(create_action.values["record_key"]): RECORD_ID},
    }
    context = _context(tmp_path, create_action.actor_key, handler, mappings=mappings)

    execute_board_control(create_action, dataset, context)
    context.runtime_mappings["control_links"] = {delete_action.target_key: LINK_ID}
    execute_board_control(delete_action, dataset, context)

    create = next(request for request in seen if request.method == "POST")
    assert create.url.path == links_path
    assert json.loads(create.content) == {
        "record_id": RECORD_ID,
        "board_revision": 6,
        "content_revision": 3,
    }
    delete = next(request for request in seen if request.method == "DELETE")
    assert delete.url.path == f"{links_path}/{LINK_ID}"
    assert json.loads(delete.content) == {"board_revision": 6, "content_revision": 3}


def test_widget_patch_and_duplicate_use_frontend_revision_bodies(tmp_path: Path) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 1), organization=get_pack("harbor"))
    patch_action = _action(dataset, "widget_patch")
    duplicate_action = _action(dataset, "widget_duplicate")
    module_id = "4dc2a986-8827-478b-95cb-3de4a5ae35c6"
    duplicate_id = "599ed0d7-5ee5-4761-9b4b-a7438f209ee7"
    widgets = [
        {
            "id": WIDGET_IDS[0],
            "name": "Monthly snapshot",
            "widget_type": "summary",
            "module_id": module_id,
            "config": {
                "version": 1,
                "fields": [],
                "filters": [],
                "logic": "and",
                "metric": None,
                "visualization": "bar",
                "size": "half",
                "refresh": "manual",
                "pinned": False,
            },
        }
    ]
    revision = 4
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal revision, widgets
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                headers=[
                    ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
                    ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly"),
                ],
                json={"ok": True},
            )
        seen.append(request)
        if request.method == "GET":
            return _response(200, {"board_revision": revision, "items": list(widgets)})
        body = json.loads(request.content)
        if request.method == "PATCH":
            assert body["revision"] == revision
            assert body["widget"]["name"] == "Fleet Reliability progress"
            widgets[0] = {**widgets[0], **body["widget"]}
            revision += 1
            return _response(
                200,
                {"widget": widgets[0], "board_revision": revision},
            )
        assert request.method == "POST"
        assert body == {"revision": revision}
        duplicate = {**widgets[0], "id": duplicate_id}
        widgets.append(duplicate)
        revision += 1
        return _response(201, {"widget": duplicate, "board_revision": revision})

    context = _context(
        tmp_path,
        patch_action.actor_key,
        handler,
        mappings={"control_boards": {"control:duplicate": BOARD_ID}},
    )

    execute_board_control(patch_action, dataset, context)
    execute_board_control(duplicate_action, dataset, context)

    patch_request = next(request for request in seen if request.method == "PATCH")
    assert patch_request.url.path == f"/api/boards/{BOARD_ID}/widgets/{WIDGET_IDS[0]}"
    patch_body = json.loads(patch_request.content)
    assert patch_body == {
        "revision": 4,
        "widget": {
            "name": f"{widgets[0]['name']}",
            "widget_type": "summary",
            "module_id": module_id,
            "config": {
                "version": 1,
                "fields": [],
                "filters": [],
                "logic": "and",
                "metric": None,
                "visualization": "bar",
                "size": "half",
                "refresh": "manual",
                "pinned": False,
            },
        },
    }
    duplicate = next(request for request in seen if request.method == "POST")
    assert duplicate.url.path == f"/api/boards/{BOARD_ID}/widgets/{WIDGET_IDS[0]}/duplicate"
    assert json.loads(duplicate.content) == {"revision": 5}
