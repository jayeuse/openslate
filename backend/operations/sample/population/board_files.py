"""Seeded Board attachments: add a blank file to a post or event, then read it back.

A team member reserves the file, uploads its bytes and attaches it, as the Board
attachment panel does. The readback downloads one attachment of each file type and
checks what the frontend checks before it offers the file to a person.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import quote

import httpx

from operations.sample.client import SampleClient, SampleClientError
from operations.sample.dummy_files import dummy_file, extension_of
from operations.sample.packs.content_types import BoardFileSpec
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.registry import default_pack
from operations.sample.population.content import SampleContentError, _id, _json

UPLOAD_HEADERS = {"Content-Type": "application/octet-stream"}


def download_issue(response: httpx.Response, filename: str) -> str | None:
    """Return why a Board attachment download differs from the seeded blank file."""
    expected = dummy_file(filename)
    disposition = response.headers.get("Content-Disposition", "")
    if response.status_code != 200:
        return f"Attachment download returned HTTP {response.status_code}"
    if (
        not disposition.lower().startswith("attachment;")
        or not disposition.endswith("filename*=UTF-8''" + quote(filename, safe=""))
        or response.headers.get("X-Content-Type-Options", "").lower() != "nosniff"
    ):
        return "Attachment download headers are not a safe file download"
    if response.headers.get("Content-Length") != str(len(expected)):
        return "Attachment download length differs from the uploaded file"
    if response.content != expected:
        return "Attachment download bytes differ from the uploaded file"
    return None


def _content_revision(
    client: SampleClient, board_id: str, kind: str, content_id: str
) -> tuple[int, int]:
    board = _json(client, "GET", f"/api/boards/{board_id}")
    is_post = kind == "post"
    current = _json(
        client,
        "GET",
        f"/api/boards/{board_id}/{kind}s/{content_id}",
        params={"view": "draft"} if is_post else None,
    )
    board_revision = board.get("revision")
    content_revision = current.get("post_revision" if is_post else "revision")
    if (
        board.get("id") != board_id
        or type(board_revision) is not int
        or type(content_revision) is not int
    ):
        raise SampleContentError(f"Board or {kind} revision is unavailable for an attachment")
    return board_revision, content_revision


def attach_seeded_file(
    client: SampleClient, board_id: str, kind: str, content_id: str, filename: str
) -> str:
    """Reserve, upload and attach one blank file; return the ready file's ID."""
    content = dummy_file(filename)
    reserved = _json(
        client,
        "POST",
        f"/api/boards/{board_id}/files",
        body={"filename": filename, "expected_size": len(content)},
        expected=(201,),
    )
    file_id = _id(reserved)
    if reserved.get("state") != "awaiting_upload" or reserved.get("board_id") != board_id:
        raise SampleContentError("Board file reservation is not awaiting its upload")
    uploaded = _json(
        client,
        "PUT",
        f"/api/boards/{board_id}/files/{file_id}/content",
        headers=UPLOAD_HEADERS,
        content=content,
        expected=(200,),
    )
    if (
        uploaded.get("id") != file_id
        or uploaded.get("state") != "ready"
        or uploaded.get("actual_size") != len(content)
    ):
        raise SampleContentError("Board file upload did not finish ready")
    board_revision, content_revision = _content_revision(client, board_id, kind, content_id)
    attached = _json(
        client,
        "POST",
        f"/api/boards/{board_id}/{kind}s/{content_id}/attachments",
        body={
            "file_id": file_id,
            "board_revision": board_revision,
            "content_revision": content_revision,
        },
        expected=(200,),
    )
    if attached.get("id") != file_id or attached.get("state") != "ready":
        raise SampleContentError("Board file was not attached ready")
    return file_id


def readback_files(organization: OrganizationPack) -> tuple[BoardFileSpec, ...]:
    """The first seeded attachment of each file type, the ones the readback downloads."""
    chosen: dict[str, BoardFileSpec] = {}
    for item in organization.content.data.board_files:
        chosen.setdefault(extension_of(item.filename), item)
    return tuple(chosen.values())


def _download_one(
    admin: SampleClient,
    item: BoardFileSpec,
    mappings: Mapping[str, Mapping[str, str]],
    organization: OrganizationPack,
) -> str | None:
    spec = organization.content.data
    board_id = mappings.get("boards", {}).get(item.board)
    bucket = "posts" if item.kind == "post" else "events"
    content_id = mappings.get(bucket, {}).get(f"{item.board}:{item.kind}:{item.index + 1:02d}")
    if board_id is None or content_id is None:
        return "A seeded attachment's post or event is absent from the run mapping"
    params: dict[str, Any] = {"limit": 100, "offset": 0}
    if item.kind == "post":
        state = spec.post_states[item.index // 2]
        params["view"] = "published" if state == "published" else "draft"
    base = f"/api/boards/{board_id}/{item.kind}s/{content_id}/attachments"
    page = _json(admin, "GET", base, params=params)
    rows = page.get("items")
    if not isinstance(rows, list):
        return "A seeded attachment list is invalid"
    match = [
        row for row in rows if isinstance(row, Mapping) and row.get("filename") == item.filename
    ]
    if len(match) != 1 or match[0].get("state") != "ready":
        return "A seeded attachment is not listed once as ready"
    file_id = _id(match[0])
    recorded = mappings.get("files", {}).get(item.key)
    if recorded is None:
        return "A seeded attachment is absent from the run mapping"
    if file_id != recorded:
        return "A seeded attachment does not match its recorded file"
    query = {"view": params["view"]} if "view" in params else None
    return download_issue(admin.request("GET", f"{base}/{file_id}/content", params=query),
                          item.filename)  # fmt: skip


def verify_seeded_attachments(
    admin: SampleClient,
    *,
    mappings: Mapping[str, Mapping[str, str]],
    organization: OrganizationPack | None = None,
) -> tuple[int, list[str]]:
    """Download one seeded attachment of each file type; return the count and issues."""
    pack = organization or default_pack()
    checked = 0
    issues: list[str] = []
    for item in readback_files(pack):
        try:
            issue = _download_one(admin, item, mappings, pack)
        except (SampleClientError, SampleContentError):
            issue = "A seeded attachment could not be read back"
        if issue is None:
            checked += 1
        else:
            issues.append(issue)
    return checked, issues
