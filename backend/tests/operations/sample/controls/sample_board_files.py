"""Independent stateful Board-file wire fixture for retained and purge journeys."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import httpx

from operations.sample.client import SampleClient
from operations.sample.dummy_files import dummy_file
from operations.sample.phases.actions import PhaseExecutionContext

ADMIN_ID = "91e28191-4492-4fb9-8bf8-42bd2a985123"


ACTOR_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"


BOARD_ID = "a36755cf-e6ed-4da7-bdee-d9154423b3fb"


POST_ID = "271570e8-4c3c-4a0b-8879-ab374a1fc9c3"


EVENT_ID = "9748c02c-7e61-483e-ae88-6674e1bbcc4f"


FILE_IDS = ("0d8b4f0e-31f4-4b7e-9f39-4f5f2d0f6a11", "5c1a9d8e-0b9f-4e31-8f0a-1c7f0e2a9b22")


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
        "purpose": "board_attachment",
        "record_id": None,
        "department_id": None,
        "creator_id": ACTOR_ID,
        "media_type": "application/pdf",
        "failure_code": None,
        "is_deleted": False,
        "created_at": "2026-10-05T00:00:00Z",
        "updated_at": "2026-10-05T00:00:00Z",
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
        self.archived: set[str] = set()
        self.purged: set[str] = set()
        self.fault = ""
        self.latest_archive = FILE_IDS[0]

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
            return _ok(
                200, {"id": BOARD_ID, "revision": self.revisions["board"], "status": "active"}
            )
        if path == f"{base}/files" and method == "GET":
            offset = int(request.url.params.get("offset", "0"))
            rows = [self.metadata(f) for f in self.archived]
            total = len(rows)
            if self.fault == "later_page":
                total = 101
                if offset == 0:
                    rows = [
                        {
                            **self.metadata(self.latest_archive),
                            "id": f"00000000-0000-4000-8000-{i + 200:012d}",
                            "filename": "unrelated-archived.pdf",
                        }
                        for i in range(100)
                    ]
                else:
                    rows = [self.metadata(self.latest_archive)]
            if self.fault == "wrong_page_purpose":
                rows[0]["purpose"] = "library_document"
            if self.fault == "missing_page_field":
                del rows[0]["created_at"]
            if self.fault == "nonadvancing_page":
                rows, total = [], 101
            return _ok(
                200,
                {
                    "items": rows,
                    "pagination": {
                        "limit": 100,
                        "offset": offset,
                        "count": len(rows),
                        "total": total,
                        "has_more": offset + len(rows) < total,
                    },
                },
            )
        if path.startswith(f"{base}/files/"):
            file_id = path.split("/")[5]
            if path.endswith("/archive"):
                self.archived.add(file_id)
                self.latest_archive = file_id
                return _ok(200, self.metadata(file_id))
            if path.endswith("/purge/preview"):
                preview = {
                    "impact": {
                        "target_type": "file",
                        "target_id": file_id,
                        "operation": "purge",
                        "actor_id": ADMIN_ID,
                        "rows": [],
                        "external_impacts": [],
                        "key_strips": [],
                        "blockers": [],
                        "impact_digest": "a" * 64,
                    },
                    "token": "owned-file-preview",
                    "expires_at": "2030-01-01T00:00:00Z",
                    "confirmation_name": self.names[file_id],
                    "last_successful_backup_at": None,
                }
                if self.fault == "naive_expiry":
                    preview["expires_at"] = "2030-01-01T00:00:00"
                if self.fault == "expired":
                    preview["expires_at"] = "2000-01-01T00:00:00Z"
                if self.fault == "wrong_preview":
                    preview["impact"]["target_id"] = EVENT_ID
                if self.fault == "wrong_name":
                    preview["confirmation_name"] = "foreign-file.pdf"
                return _ok(200, preview)
            if path.endswith("/purge"):
                assert json.loads(request.content) == {
                    "token": "owned-file-preview",
                    "confirmation_name": self.names[file_id],
                    "password": "fixture-only",
                }
                if self.fault == "unavailable":
                    return _ok(503, {"detail": "private dependency"})
                self.purged.add(file_id)
                return _ok(200, self.metadata(file_id))
            if path.endswith("/content"):
                # The server accepts only uploads on this path, like the real router.
                return _ok(405)
            return _ok(200, self.metadata(file_id))
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

    def metadata(self, file_id: str) -> dict[str, Any]:
        row = _file(file_id, self.names[file_id], "purged" if file_id in self.purged else "ready")
        row["actual_size"] = len(dummy_file(self.names[file_id]))
        row["is_deleted"] = file_id in self.archived
        if self.fault == "wrong_board":
            row["board_id"] = EVENT_ID
        if self.fault == "not_purged" and file_id in self.purged:
            row["state"] = "ready"
        return row


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
        clients={actor: client, "admin": client},
        user_ids={actor: ACTOR_ID, "admin": ADMIN_ID},
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


class FinalReadbackBoard(FakeBoard):
    """Keep the completed API journey genuine; alter fresh final metadata only."""

    def __init__(self, names: list[str], *, creator_id: str = ACTOR_ID) -> None:
        super().__init__(names)
        self.creator_id = creator_id
        self.final_fault: str | None = None
        self.altered_final_reads = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        response = super().__call__(request)
        if not response.headers.get("Content-Type", "").startswith("application/json"):
            return response
        body = response.json()
        if isinstance(body, dict) and body.get("purpose") == "board_attachment":
            body["creator_id"] = self.creator_id
        elif isinstance(body, dict) and isinstance(body.get("items"), list):
            for row in body["items"]:
                if isinstance(row, dict) and row.get("purpose") == "board_attachment":
                    row["creator_id"] = self.creator_id
        if (
            self.final_fault is not None
            and request.method == "GET"
            and request.url.path
            in {f"/api/boards/{BOARD_ID}/files/{file_id}" for file_id in FILE_IDS}
        ):
            from app.systems.platform.files.schemas import FilePurpose

            if self.final_fault == "purpose":
                body["purpose"] = FilePurpose.LIBRARY_DOCUMENT.value
            elif self.final_fault == "missing_creator":
                del body["creator_id"]
            elif self.final_fault == "creator":
                body["creator_id"] = EVENT_ID
            elif self.final_fault == "expected_size":
                body["expected_size"] += 1
            elif self.final_fault == "actual_size":
                body["actual_size"] += 1
            elif self.final_fault == "record_parent":
                body["record_id"] = EVENT_ID
            elif self.final_fault == "department_parent":
                body["department_id"] = EVENT_ID
            elif self.final_fault == "failure":
                body["failure_code"] = "deletion_unresolved"
            else:
                raise AssertionError("Unknown final metadata fault")
            self.altered_final_reads += 1
        return httpx.Response(
            response.status_code,
            json=body,
            headers={
                key: value
                for key, value in response.headers.items()
                if key.lower() != "content-length"
            },
        )
