"""Readback must reject incomplete sample content and incorrect Board grants."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest

from operations.sample_boards import verify_boards
from operations.sample_client import SampleClient
from operations.sample_content import verify_content

BOARD_ID = "00000000-0000-7000-8000-000000000101"
OPERATIONS_GROUP = "00000000-0000-7000-8000-000000000102"
GUEST_GROUP = "00000000-0000-7000-8000-000000000103"
FINANCE_GROUP = "00000000-0000-7000-8000-000000000104"
OTHER_GROUP = "00000000-0000-7000-8000-000000000105"

EXPECTED_CONTENT = {
    "boards": 12,
    "widgets": 48,
    "posts": 96,
    "events": 144,
    "reminders": 24,
    "files": 60,
    "record_links": 4,
    "project_group_grants": 15,
    "post_publications": 70,
    "publication_revisions": 2,
    "views": 36,
    "dashboards": 6,
    "dashboard_widgets": 24,
    "reports": 12,
    "report_runs": 12,
    "schedules": 12,
    "disabled_schedules": 12,
}


@pytest.mark.parametrize(
    "missing_key",
    (
        "record_links",
        "project_group_grants",
        "post_publications",
        "publication_revisions",
        "disabled_schedules",
    ),
)
def test_content_readback_rejects_each_missing_required_outcome(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, missing_key: str
) -> None:
    from operations import sample_boards, sample_openview

    observed = {**EXPECTED_CONTENT, "report_outputs": 12, "read_failures": 0}
    observed[missing_key] -= 1
    board_keys = {
        "boards", "widgets", "posts", "events", "reminders", "files", "record_links",
        "project_group_grants", "post_publications", "publication_revisions", "read_failures",
    }
    monkeypatch.setattr(
        sample_boards,
        "verify_boards",
        lambda _admin, *, mappings: {key: observed[key] for key in board_keys},
    )
    monkeypatch.setattr(
        sample_openview,
        "verify_openview",
        lambda _admin, *, mappings: {
            key: value for key, value in observed.items() if key not in board_keys
        },
    )
    with SampleClient(
        "https://api.example.test",
        "https://workspace.example.test",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(lambda _request: pytest.fail("no API request expected")),
    ) as client:
        result = verify_content(
            client,
            run_manifest={"expected": EXPECTED_CONTENT},
            mappings={},
        )

    assert result["missing_" + missing_key] == 1
    assert result["content_complete"] == 0


def _page(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "items": rows,
        "pagination": {
            "limit": 100,
            "offset": 0,
            "count": len(rows),
            "total": len(rows),
            "has_more": False,
        },
    }


@pytest.mark.parametrize("wrong", ("none", "level", "group", "extra"))
def test_project_board_grants_require_exact_intended_groups_and_levels(
    tmp_path: Path, wrong: str
) -> None:
    grants = [
        {"group_id": OPERATIONS_GROUP, "name": "Harbor Operations", "level": "write"},
        {"group_id": GUEST_GROUP, "name": "Guest Readers", "level": "read"},
        # The Finance team writes on its project Board.
        {"group_id": FINANCE_GROUP, "name": "Finance Review", "level": "write"},
    ]
    if wrong == "level":
        grants[2]["level"] = "read"
    elif wrong == "group":
        grants[2]["group_id"] = OTHER_GROUP
    elif wrong == "extra":
        grants.append({"group_id": OTHER_GROUP, "name": "Other", "level": "read"})

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                json={"authenticated": True, "setup_required": False},
                headers=[("set-cookie", "openslate_csrf=sample-csrf; Path=/")],
            )
        if request.url.path == "/api/boards":
            return httpx.Response(200, json=_page([{"id": BOARD_ID, "scope": "project"}]))
        if request.url.path == f"/api/boards/{BOARD_ID}/groups":
            return httpx.Response(
                200, json={"board_id": BOARD_ID, "revision": 3, "groups": grants}
            )
        if request.url.path in {
            f"/api/boards/{BOARD_ID}/widgets",
            f"/api/boards/{BOARD_ID}/posts",
            f"/api/boards/{BOARD_ID}/events",
        }:
            return httpx.Response(200, json=_page([]))
        raise AssertionError(f"Unexpected GET {request.url.path}")

    mappings = {
        "boards": {"project:finance:month-end-close": BOARD_ID},
        "group": {
            "harbor-operations": OPERATIONS_GROUP,
            "guest-readers": GUEST_GROUP,
            "finance-review": FINANCE_GROUP,
        },
    }
    with SampleClient(
        "https://api.example.test",
        "https://workspace.example.test",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        assert client.login("sample@example.test", "synthetic-password").status_code == 200
        result = verify_boards(client, mappings=mappings)

    if wrong == "none":
        assert result["project_group_grants"] == 3
        assert result["read_failures"] == 0
    else:
        assert result["read_failures"] > 0
        assert result["project_group_grants"] < 3 or wrong == "extra"
