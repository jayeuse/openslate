"""Seeded Board attachments: planned from pack data, uploaded raw, read back exactly."""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.dummy_files import MEDIA_TYPES, dummy_file, extension_of
from operations.sample.packs.registry import get_pack
from operations.sample.population.board_files import (
    attach_seeded_file,
    readback_files,
    verify_seeded_attachments,
)
from operations.sample.population.board_steps import BoardMeta, plan_board_steps
from operations.sample.population.boards import project_board_logical_id

BOARD_ID = "a36755cf-e6ed-4da7-bdee-d9154423b3fb"
POST_ID = "271570e8-4c3c-4a0b-8879-ab374a1fc9c3"
EVENT_ID = "9748c02c-7e61-483e-ae88-6674e1bbcc4f"
FILE_ID = "0d8b4f0e-31f4-4b7e-9f39-4f5f2d0f6a11"


def _boards(pack_key: str) -> list[BoardMeta]:
    pack = get_pack(pack_key)
    team = pack.actors.team_keys
    boards = [BoardMeta("company", None, "company", ("admin",))]
    boards += [
        BoardMeta(f"department:{key}", key, "department", tuple(team[key]))
        for key, _ in pack.catalog.departments
    ]
    boards += [
        BoardMeta(project_board_logical_id(key, name), key, "project", tuple(team[key]))
        for name, key in pack.content.data.projects
    ]
    return boards


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_seeded_files_attach_before_the_post_life_cycle_and_avoid_the_anchor(
    pack_key: str,
) -> None:
    pack = get_pack(pack_key)
    content = pack.content.data
    name, department = pack.phases.existing_project_board
    anchor = project_board_logical_id(department, name)

    steps = plan_board_steps(_boards(pack_key), organization=pack)

    position = {step.key: index for index, step in enumerate(steps)}
    authors = {step.key: step.author_key for step in steps}
    files = [step for step in steps if step.kind == "file"]
    assert [step.key for step in files] == [item.key for item in content.board_files]
    assert len(files) == pack.content.supporting_counts["attachments"]
    assert {extension_of(item.filename) for item in content.board_files} == set(MEDIA_TYPES)
    assert all(item.board != anchor for item in content.board_files)
    for step in files:
        parent = step.needs_steps[0]
        assert step.author_key == authors[parent]
        if parent.startswith("post:"):
            # Archived posts (indexes 6-7) are not listed by the content readback.
            assert content.post_states[step.index // 2] != "archived"
            lifecycle = f"lifecycle:{step.board}:{step.index}"
            if lifecycle in position:
                assert step.key in next(s for s in steps if s.key == lifecycle).needs_steps
                assert position[step.key] < position[lifecycle]
    chosen = readback_files(pack)
    assert {extension_of(item.filename) for item in chosen} == {
        extension_of(item.filename) for item in content.board_files
    }
    assert {item.kind for item in chosen} == {"post", "event"}


def _login() -> httpx.Response:
    return httpx.Response(
        200,
        headers=[
            ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
            ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly"),
        ],
        json={"ok": True},
    )


def _client(tmp_path: Path, handler) -> SampleClient:
    client = SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    )
    assert client.login("sample@example.test", "fixture-only").status_code == 200
    return client


def test_seeded_file_reserves_uploads_raw_bytes_then_attaches_to_the_draft(
    tmp_path: Path,
) -> None:
    name = "Dock 3 loading plan.pdf"
    seen: list[httpx.Request] = []
    base = f"/api/boards/{BOARD_ID}"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login()
        seen.append(request)
        size = len(dummy_file(name))
        file = {"id": FILE_ID, "board_id": BOARD_ID, "actual_size": size}
        if request.method == "POST" and request.url.path == f"{base}/files":
            return httpx.Response(201, json={**file, "state": "awaiting_upload"})
        if request.method == "PUT":
            return httpx.Response(200, json={**file, "state": "ready"})
        if request.url.path == base:
            return httpx.Response(200, json={"id": BOARD_ID, "revision": 9})
        if request.method == "GET":
            assert request.url.params["view"] == "draft"
            return httpx.Response(200, json={"id": POST_ID, "post_revision": 4})
        return httpx.Response(200, json={**file, "state": "ready"})

    with _client(tmp_path, handler) as client:
        assert attach_seeded_file(client, BOARD_ID, "post", POST_ID, name) == FILE_ID

    reserve, upload, *_, attach = seen
    assert json.loads(reserve.content) == {"filename": name, "expected_size": len(dummy_file(name))}
    assert upload.url.path == f"{base}/files/{FILE_ID}/content"
    assert upload.content == dummy_file(name)
    assert upload.headers["Content-Type"] == "application/octet-stream"
    assert attach.url.path == f"{base}/posts/{POST_ID}/attachments"
    assert json.loads(attach.content) == {
        "file_id": FILE_ID,
        "board_revision": 9,
        "content_revision": 4,
    }


@pytest.mark.parametrize(
    "broken", ("none", "bytes", "length", "disposition", "identity", "unmapped")
)
def test_readback_downloads_one_file_per_type_and_checks_headers_and_bytes(
    tmp_path: Path, broken: str
) -> None:
    pack = get_pack("harbor")
    chosen = readback_files(pack)
    target = chosen[0]
    ids = {item.filename: str(uuid4()) for item in chosen}
    mappings = {"boards": {}, "posts": {}, "events": {}, "files": {}}
    for item in chosen:
        mappings["boards"][item.board] = BOARD_ID
        if not (item is target and broken == "unmapped"):
            mappings["files"][item.key] = ids[item.filename]
        bucket = "posts" if item.kind == "post" else "events"
        mappings[bucket][f"{item.board}:{item.kind}:{item.index + 1:02d}"] = str(uuid4())
    downloads: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login()
        path = request.url.path
        content_id = path.split("/")[5]
        item = next(
            row
            for row in chosen
            if mappings["posts" if row.kind == "post" else "events"].get(
                f"{row.board}:{row.kind}:{row.index + 1:02d}"
            )
            == content_id
        )
        if path.endswith("/attachments"):
            # Review finding E: same name and bytes under another file id must not pass.
            listed = str(uuid4()) if item is target and broken == "identity" else ids[item.filename]
            row = {"id": listed, "filename": item.filename, "state": "ready"}
            return httpx.Response(200, json={"items": [row], "has_more": False})
        downloads.append(request)
        content = dummy_file(item.filename)
        disposition = "attachment; filename*=UTF-8''" + quote(item.filename, safe="")
        if item is target and broken == "bytes":
            content = content[:-1] + b"X"
        if item is target and broken == "disposition":
            disposition = "inline"
        headers = {"Content-Disposition": disposition, "X-Content-Type-Options": "nosniff"}
        if item is target and broken == "length":
            content += b" "
        return httpx.Response(200, content=content, headers=headers)

    with _client(tmp_path, handler) as client:
        checked, issues = verify_seeded_attachments(client, mappings=mappings, organization=pack)

    assert len(chosen) == len({extension_of(i.filename) for i in chosen})
    # A wrong or unrecorded identity is refused before its bytes are fetched.
    assert len(downloads) == len(chosen) - (broken in {"identity", "unmapped"})
    post_downloads = [r for r in downloads if "/posts/" in r.url.path]
    assert post_downloads and all(r.url.params.get("view") for r in post_downloads)
    if broken == "none":
        assert (checked, issues) == (len(chosen), [])
    else:
        assert checked == len(chosen) - 1 and len(issues) == 1
