"""Board attachment controls: planned from pack data, sent in the frontend's shape."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.controls.actions import plan_controls
from operations.sample.controls.board_files import (
    board_author,
    plan_board_file_controls,
    verify_board_file_controls,
)
from operations.sample.controls.boards import CONTROL_ROUTES, execute_board_control
from operations.sample.controls.request_verification import verify_request_evidence
from operations.sample.dummy_files import dummy_file, extension_of
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.population.boards import project_board_logical_id
from operations.sample.scenario import build_dataset
from operations.sample.verification.route_coverage import SEEDER_ROUTES

ACTOR_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"
BOARD_ID = "a36755cf-e6ed-4da7-bdee-d9154423b3fb"
POST_ID = "271570e8-4c3c-4a0b-8879-ab374a1fc9c3"
EVENT_ID = "9748c02c-7e61-483e-ae88-6674e1bbcc4f"
FILE_IDS = ("0d8b4f0e-31f4-4b7e-9f39-4f5f2d0f6a11", "5c1a9d8e-0b9f-4e31-8f0a-1c7f0e2a9b22")


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_file_controls_use_the_anchor_boards_seeded_post_event_and_author(pack_key: str) -> None:
    pack = get_pack(pack_key)
    dataset = build_dataset("small", 83, date(2026, 10, 5), organization=pack)

    actions = plan_board_file_controls(dataset)

    assert [(a.values["operation"], a.expected_status) for a in actions] == [
        ("board_file_reserve", 201),
        ("board_file_upload", 200),
        ("post_attachment_create", 200),
        ("post_attachment_delete", 204),
        ("event_attachment_create", 200),
        ("event_attachment_delete", 204),
    ]
    name, department = pack.phases.existing_project_board
    board_key = project_board_logical_id(department, name)
    assert {a.values["board_key"] for a in actions} == {board_key}
    assert all(a.kind == "board_controls" for a in actions)
    post_key, event_key = actions[2].values["content_key"], actions[4].values["content_key"]
    assert actions[3].values["content_key"] == post_key
    assert actions[5].values["content_key"] == event_key
    post_index = int(post_key.rsplit(":", 1)[1]) - 1
    event_index = int(event_key.rsplit(":", 1)[1]) - 1
    assert post_key.startswith(f"{board_key}:post:")
    assert event_key.startswith(f"{board_key}:event:")
    assert pack.content.data.post_states[post_index // 2] == "draft"
    author = board_author(dataset, department, name, post_index)
    assert board_author(dataset, department, name, event_index + 1) == author
    assert {a.actor_key for a in actions} == {author} and author != "admin"
    # One file per owner: a file attached to the post can never move to the event.
    files = actions[0].values["files"]
    assert files == actions[1].values["files"]
    assert [row["file_key"] for row in files] == [
        actions[2].values["file_key"],
        actions[4].values["file_key"],
    ]
    names = [row["filename"] for row in files]
    pack_names = {item.filename for item in pack.content.data.board_files}
    assert set(names) <= pack_names and len({extension_of(n) for n in names}) == 2
    assert actions[2].values["filename"] == names[0]
    assert actions[4].values["filename"] == names[1]

    planned = plan_controls(dataset)
    assert len(planned) == 102
    assert [a.key for a in planned if a.key in {b.key for b in actions}] == [a.key for a in actions]
    assert CONTROL_ROUTES >= {
        ("PUT", "/api/boards/{board_id}/files/{file_id}/content"),
        ("GET", "/api/boards/{board_id}/events/{event_id}/attachments/{file_id}/content"),
    }
    assert CONTROL_ROUTES <= SEEDER_ROUTES


def _login(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        headers=[
            ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
            ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly"),
        ],
        json={"ok": True},
    )


def _ok(status: int, body: object | None = None, **headers: str) -> httpx.Response:
    all_headers = {"X-Request-ID": str(uuid4()), **headers}
    if body is None:
        return httpx.Response(status, headers=all_headers)
    return httpx.Response(status, headers=all_headers, json=body)


def _file(file_id: str, name: str, state: str) -> dict[str, Any]:
    size = len(dummy_file(name))
    return {
        "id": file_id,
        "board_id": BOARD_ID,
        "filename": name,
        "state": state,
        "expected_size": size,
        "actual_size": size if state == "ready" else None,
    }


class FakeBoard:
    """Server-shaped Board file routes; attach and detach bump the revisions."""

    def __init__(self, names: list[str]) -> None:
        self.names = dict(zip(FILE_IDS, names, strict=True))
        self.reserved: list[str] = []
        self.linked: dict[str, set[str]] = {POST_ID: set(), EVENT_ID: set()}
        self.revisions = {"board": 3, POST_ID: 5, EVENT_ID: 7}
        self.seen: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login(request)
        self.seen.append(request)
        path, method = request.url.path, request.method
        base = f"/api/boards/{BOARD_ID}"
        if method == "POST" and path == f"{base}/files":
            file_id = FILE_IDS[len(self.reserved)]
            self.reserved.append(file_id)
            return _ok(201, _file(file_id, self.names[file_id], "awaiting_upload"))
        if method == "PUT":
            file_id = path.split("/")[-2]
            return _ok(200, _file(file_id, self.names[file_id], "ready"))
        if path == base:
            return _ok(200, {"id": BOARD_ID, "revision": self.revisions["board"]})
        kind, content_id, *rest = path.removeprefix(base + "/").split("/")
        key = "post_revision" if kind == "posts" else "revision"
        if not rest:
            revision = self.revisions[content_id]
            return _ok(200, {"id": content_id, "board_id": BOARD_ID, key: revision})
        if rest == ["attachments"] and method == "GET":
            items = [_file(f, self.names[f], "ready") for f in sorted(self.linked[content_id])]
            return _ok(200, {"items": items, "limit": 25, "offset": 0, "has_more": False})
        if rest == ["attachments"] and method == "POST":
            body = json.loads(request.content)
            self.linked[content_id].add(body["file_id"])
            self.revisions["board"] += 1
            self.revisions[content_id] += 1
            return _ok(200, _file(body["file_id"], self.names[body["file_id"]], "ready"))
        if method == "DELETE":
            self.linked[content_id].discard(rest[1])
            self.revisions["board"] += 1
            self.revisions[content_id] += 1
            return _ok(204)
        name = self.names[rest[1]]
        content = dummy_file(name)
        return httpx.Response(
            200,
            content=content,
            headers={
                "Content-Type": "application/octet-stream",
                "Content-Disposition": "attachment; filename*=UTF-8''" + quote(name, safe=""),
                "X-Content-Type-Options": "nosniff",
            },
        )


def _context(tmp_path: Path, actions: tuple[Any, ...], handler: FakeBoard) -> PhaseExecutionContext:
    actor, board_key = actions[0].actor_key, actions[0].values["board_key"]
    post_key, event_key = actions[2].values["content_key"], actions[4].values["content_key"]
    client = SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "board-file-requests.jsonl",
        transport=httpx.MockTransport(handler),
    )
    assert client.login("sample@example.test", "fixture-only").status_code == 200
    return PhaseExecutionContext(
        clients={actor: client},
        user_ids={actor: ACTOR_ID},
        group_ids={},
        department_ids={},
        module_ids={},
        field_ids={},
        mappings={
            "boards": {board_key: BOARD_ID},
            "posts": {post_key: POST_ID},
            "events": {event_key: EVENT_ID},
        },
        admin_password="fixture-only",
    )


def test_file_controls_send_raw_bytes_and_the_attachment_panel_bodies(tmp_path: Path) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 5), organization=get_pack("harbor"))
    actions = plan_board_file_controls(dataset)
    names = [row["filename"] for row in actions[0].values["files"]]
    fake = FakeBoard(names)
    context = _context(tmp_path, actions, fake)

    results = [execute_board_control(action, dataset, context) for action in actions]

    writes = [r for r in fake.seen if r.method != "GET"]
    assert [(r.method, r.url.path.removeprefix(f"/api/boards/{BOARD_ID}")) for r in writes] == [
        ("POST", "/files"),
        ("POST", "/files"),
        ("PUT", f"/files/{FILE_IDS[0]}/content"),
        ("PUT", f"/files/{FILE_IDS[1]}/content"),
        ("POST", f"/posts/{POST_ID}/attachments"),
        ("DELETE", f"/posts/{POST_ID}/attachments/{FILE_IDS[0]}"),
        ("POST", f"/events/{EVENT_ID}/attachments"),
        ("DELETE", f"/events/{EVENT_ID}/attachments/{FILE_IDS[1]}"),
    ]
    assert [json.loads(r.content) for r in writes[:2]] == [
        {"filename": name, "expected_size": len(dummy_file(name))} for name in names
    ]
    for request, name in zip(writes[2:4], names, strict=True):
        assert request.content == dummy_file(name)
        assert request.headers["Content-Type"] == "application/octet-stream"
    assert json.loads(writes[4].content) == {
        "file_id": FILE_IDS[0],
        "board_revision": 3,
        "content_revision": 5,
    }
    assert json.loads(writes[5].content) == {"board_revision": 4, "content_revision": 6}
    assert json.loads(writes[6].content) == {
        "file_id": FILE_IDS[1],
        "board_revision": 5,
        "content_revision": 7,
    }
    post_reads = [r for r in fake.seen if r.method == "GET" and f"/posts/{POST_ID}" in r.url.path]
    assert post_reads and all(r.url.params.get("view") == "draft" for r in post_reads)
    downloads = [r for r in fake.seen if r.url.path.endswith("/content") and r.method == "GET"]
    assert len(downloads) == 2
    for result, action in zip(results, actions, strict=True):
        evidence = result["request_evidence"]
        assert evidence and all(
            item["actor_key"] == action.actor_key
            and item["actor_id"] == ACTOR_ID
            and item["status_code"] == item["expected_status"] == action.expected_status
            for item in evidence
        )
    assert fake.linked == {POST_ID: set(), EVENT_ID: set()}
    # The run verifier accepts the evidence: unique steps, known routes, planned actor.
    issues: list[str] = []
    observed = {"control_requests_verified": 0}
    actors = {actions[0].actor_key: ACTOR_ID}
    seen: set[str] = set()
    for action, result in zip(actions, results, strict=True):
        verify_request_evidence(
            dataset, {"actor_ids": actors}, action, result, actors, ACTOR_ID, seen, observed,
            issues,
        )  # fmt: skip
    assert issues == []
    assert observed["control_requests_verified"] == 8


def test_file_control_refuses_a_download_that_differs_from_the_upload(tmp_path: Path) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 5), organization=get_pack("school"))
    actions = plan_board_file_controls(dataset)
    names = [row["filename"] for row in actions[0].values["files"]]

    class SniffingBoard(FakeBoard):
        def __call__(self, request: httpx.Request) -> httpx.Response:
            response = super().__call__(request)
            if request.url.path.endswith("/content") and request.method == "GET":
                del response.headers["X-Content-Type-Options"]
            return response

    fake = SniffingBoard(names)
    context = _context(tmp_path, actions, fake)
    for action in actions[:2]:
        execute_board_control(action, dataset, context)

    with pytest.raises(SamplePhaseActionError, match="safe file download"):
        execute_board_control(actions[2], dataset, context)


@pytest.mark.parametrize("still_attached", (False, True))
def test_verifier_requires_control_files_detached_at_the_end(
    tmp_path: Path, still_attached: bool
) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 5), organization=get_pack("harbor"))
    actions = plan_board_file_controls(dataset)
    names = [row["filename"] for row in actions[0].values["files"]]
    fake = FakeBoard(names)
    if still_attached:
        fake.linked[EVENT_ID].add(FILE_IDS[1])
    client = SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "verify.jsonl",
        transport=httpx.MockTransport(fake),
    )
    mappings = {
        "boards": {actions[0].values["board_key"]: BOARD_ID},
        "posts": {actions[2].values["content_key"]: POST_ID},
        "events": {actions[4].values["content_key"]: EVENT_ID},
        "control_files": {"control:post-file": FILE_IDS[0], "control:event-file": FILE_IDS[1]},
    }

    issues = verify_board_file_controls(client, actions, mappings)

    assert issues == (
        ["A Board control file is still attached after its planned removal"]
        if still_attached
        else []
    )
