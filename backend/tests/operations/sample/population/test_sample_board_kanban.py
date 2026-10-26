"""The packs' demo Kanban: managers' stages and labels, a writer's cards, and its readback."""

from __future__ import annotations

import json
from collections import Counter
from datetime import date
from pathlib import Path
from typing import Any
from uuid import UUID, uuid5

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.packs.registry import get_pack
from operations.sample.population.board_kanban import seed_kanban, verify_kanban
from tests.operations.sample.population.test_sample_content import BASE_URL, ORIGIN, _login

BOARD_ID = "00000000-0000-7000-8000-000000000201"
ANCHOR = date(2026, 10, 26)


def _uuid(*parts: object) -> str:
    return str(uuid5(UUID(BOARD_ID), ":".join(str(part) for part in parts)))


def _client(tmp_path: Path, name: str, handler: Any) -> SampleClient:
    client = SampleClient(BASE_URL, ORIGIN, tmp_path / name / "requests.jsonl",
                          transport=httpx.MockTransport(handler))  # fmt: skip
    assert client.login(f"{name}@example.test", "synthetic-password").status_code == 200
    return client


def _journal(tmp_path: Path, name: str) -> Counter[str]:
    lines = (tmp_path / name / "requests.jsonl").read_text().splitlines()
    return Counter(
        row["kind"] for row in map(json.loads, lines) if row.get("event") == "id_mapping"
    )


@pytest.mark.parametrize(
    ("pack_key", "board", "records"),
    [
        ("harbor", "department:sales",
         {"customers:000001", "customers:000003", "quotes:000001", "quotes:000002"}),
        ("school", "department:academic",
         {"courses:000001", "courses:000002", "assessments:000001", "assessments:000002"}),
    ],
)
def test_the_pack_seeds_its_demo_kanban_through_the_board_apis(
    tmp_path: Path, pack_key: str, board: str, records: set[str]
) -> None:
    pack = get_pack(pack_key)
    calls: list[tuple[str, str, str, dict[str, Any]]] = []

    def handler(who: str) -> Any:
        def respond(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/auth/login":
                return _login(request)
            body = json.loads(request.content)
            calls.append((who, request.method, request.url.path, body))
            return httpx.Response(201, json={"id": _uuid(len(calls))})
        return respond

    admin = _client(tmp_path, "admin", handler("admin"))
    writer = _client(tmp_path, "writer", handler("writer"))
    seeded = {logical: {"id": _uuid(logical)} for logical in records}
    boards = {board: {"id": BOARD_ID, "department_key": board.split(":")[1],
                      "authors": ("writer",)}}  # fmt: skip

    counts = seed_kanban(admin, boards=boards, clients={"writer": writer}, records=seeded,
                         anchor_date=ANCHOR, organization=pack)  # fmt: skip

    supporting = pack.content.supporting_counts
    assert counts == {key: supporting[key] for key in counts} == {
        "kanban_stages": 5, "kanban_labels": 3, "kanban_cards": 12, "kanban_checklist_items": 7,
    }
    base = f"/api/boards/{BOARD_ID}"
    assert Counter((who, method, path.replace(base, "")) for who, method, path, _ in calls
                   if not path.endswith("/checklist")) == {  # fmt: skip
        ("admin", "POST", "/stages"): 5,
        ("admin", "POST", "/labels"): 3,
        ("writer", "POST", "/cards"): 12,
    }
    cards = [body for _, _, path, body in calls if path == f"{base}/cards"]
    assert {body["record_id"] for body in cards if body["kind"] == "record"} == {
        _uuid(logical) for logical in records
    }
    assert all(body["title"] for body in cards if body["kind"] == "objective")
    due = sorted(date.fromisoformat(body["due_on"]) for body in cards if "due_on" in body)
    assert len(due) >= 6 and all(ANCHOR < day for day in due)
    assert _journal(tmp_path, "admin") == {"kanban_stages": 5, "kanban_labels": 3}
    assert _journal(tmp_path, "writer") == {"kanban_cards": 12}
    admin.close()
    writer.close()


@pytest.mark.parametrize("labels_status", [200, 503])
def test_kanban_readback_counts_cards_and_their_checklists(
    tmp_path: Path, labels_status: int
) -> None:
    def page(rows: list[dict[str, Any]], request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"items": rows, "pagination": {
            "limit": 100, "offset": int(request.url.params["offset"]), "count": len(rows),
            "total": len(rows), "has_more": False,
        }})  # fmt: skip

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login(request)
        kind = request.url.path.rsplit("/", 1)[1]
        if kind == "stages":
            return page([{"id": _uuid("stage", index)} for index in range(5)], request)
        if kind == "labels":
            if labels_status != 200:
                return httpx.Response(labels_status)
            return page([{"id": _uuid("label", index)} for index in range(3)], request)
        return page([{"checklist": {"done": 0, "total": 2}}, {"checklist": {"total": 1}}],
                    request)  # fmt: skip

    with _client(tmp_path, "admin", handler) as admin:
        counts, failed = verify_kanban(admin, BOARD_ID)

    if labels_status == 200:
        assert (counts, failed) == ({"kanban_stages": 5, "kanban_labels": 3, "kanban_cards": 2,
                                     "kanban_checklist_items": 3}, 0)  # fmt: skip
    else:
        assert (counts, failed) == (dict.fromkeys(counts, 0), 1)
