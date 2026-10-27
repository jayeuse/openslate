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
        mappings={"control_boards": {"control:board": BOARD_ID}},
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
        mappings={"control_boards": {"control:board": BOARD_ID}},
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
        mappings={"control_boards": {"control:board": BOARD_ID}},
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


def test_board_create_sends_the_frontend_body_and_maps_the_owned_board(tmp_path: Path) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 1), organization=get_pack("harbor"))
    action = _action(dataset, "board_create")
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
        body = json.loads(request.content)
        return _response(
            201,
            {"id": BOARD_ID, "scope": "project", "status": "active", "name": body["name"]},
        )

    context = _context(tmp_path, action.actor_key, handler, mappings={})

    result = execute_board_control(action, dataset, context)

    [create] = seen
    assert (create.method, create.url.path) == ("POST", "/api/boards")
    assert json.loads(create.content) == {
        "name": action.values["name"],
        "description": action.values["description"],
    }
    assert context.runtime_mappings["control_boards"] == {"control:board": BOARD_ID}
    assert result["request_evidence"][0]["primary_entity_id"] == BOARD_ID


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
        "control_boards": {"control:board": BOARD_ID},
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
