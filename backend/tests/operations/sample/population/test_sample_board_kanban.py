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


def _page(rows: list[dict[str, Any]], request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"items": rows, "pagination": {
        "limit": 100, "offset": int(request.url.params.get("offset", 0)), "count": len(rows),
        "total": len(rows), "has_more": False,
    }})  # fmt: skip


@pytest.mark.parametrize(
    ("pack_key", "board", "records"),
    [
        (
            "harbor",
            "department:sales",
            {"customers:000001", "customers:000003", "quotes:000001", "quotes:000002"},
        ),
        (
            "school",
            "department:academic",
            {"courses:000001", "courses:000002", "assessments:000001", "assessments:000002"},
        ),
    ],
)
def test_every_department_board_gets_a_kanban_and_calendar_sources(
    tmp_path: Path, pack_key: str, board: str, records: set[str]
) -> None:
    pack = get_pack(pack_key)
    calls: list[tuple[str, str, str, dict[str, Any]]] = []
    other = next(key for key, _ in pack.catalog.departments if key != board.split(":")[1])
    other_board = f"department:{other}"
    module = {"id": _uuid("module"), "department_id": _uuid("department", other)}
    date_field = {"id": _uuid("field"), "type": "date", "is_deleted": False}

    def handler(who: str) -> Any:
        def respond(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/auth/login":
                return _login(request)
            if request.method == "GET":
                rows = {"/api/modules": [module], "/api/fields": [date_field]}
                return _page(rows.get(request.url.path, []), request)
            body = json.loads(request.content)
            calls.append((who, request.method, request.url.path, body))
            return httpx.Response(201, json={"id": _uuid(len(calls)), "revision": 1})

        return respond

    admin = _client(tmp_path, "admin", handler("admin"))
    writer = _client(tmp_path, "writer", handler("writer"))
    seeded = {logical: {"id": _uuid(logical)} for logical in records}
    boards = {
        name: {"id": _uuid("board", name), "logical_id": name, "scope": "department",
               "department_key": name.split(":")[1], "authors": ("writer",),
               "board": {"department_id": _uuid("department", name.split(":")[1])}}
        for name in (board, other_board)
    }  # fmt: skip

    counts = seed_kanban(admin, boards=boards, clients={"writer": writer}, records=seeded,
                         anchor_date=ANCHOR, organization=pack)  # fmt: skip

    from importlib import import_module

    from operations.sample.population.board_kanban import DEFAULT_LABELS

    realism = import_module(f"operations.sample.packs.{pack_key}.realism")
    spec = pack.content.data.kanban
    stages = len(spec.stages) + len(realism.BOARD_STAGES[other])
    assert counts == {
        "kanban_stages": stages, "kanban_labels": len(spec.labels) + len(DEFAULT_LABELS),
        "kanban_cards": 24, "kanban_checklist_items": 7, "calendar_sources": 1,
    }  # fmt: skip

    def board_cards(key: str) -> list[dict[str, Any]]:
        path = f"/api/boards/{_uuid('board', key)}/cards"
        return [body for _, _, called, body in calls if called == path]

    cards = {key: board_cards(key) for key in (board, other_board)}
    assert len(cards[board]) == len(cards[other_board]) == 12
    # The demo cards keep their named records; every dated card starts before it is due.
    assert {b["record_id"] for b in cards[board] if b["kind"] == "record"} == {
        _uuid(logical) for logical in records
    }
    dated = [b for rows in cards.values() for b in rows if "due_on" in b]
    assert len(dated) >= 18
    assert all(date.fromisoformat(b["start_on"]) <= date.fromisoformat(b["due_on"]) for b in dated)
    assert all(b["title"] for rows in cards.values() for b in rows if b["kind"] == "objective")
    sources = [b for who, _, path, b in calls if path.endswith("/calendar-sources")]
    assert sources == [{"module_id": module["id"], "date_field_id": date_field["id"]}]
    assert _journal(tmp_path, "writer") == {"kanban_cards": 24}
    admin.close()
    writer.close()


@pytest.mark.parametrize("labels_status", [200, 503])
def test_kanban_readback_counts_cards_and_their_checklists(
    tmp_path: Path, labels_status: int
) -> None:
    page = _page

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login(request)
        kind = request.url.path.rsplit("/", 1)[1]
        if kind == "calendar-sources":
            return httpx.Response(200, json={"items": [{"id": _uuid("source")}]})
        if kind == "cards" and request.url.params.get("archived") == "true":
            return page([{"checklist": {"total": 0}}], request)
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
        assert (counts, failed) == ({"kanban_stages": 5, "kanban_labels": 3, "kanban_cards": 3,
                                     "kanban_checklist_items": 3, "calendar_sources": 1},
                                    0)  # fmt: skip
    else:
        assert (counts, failed) == (dict.fromkeys(counts, 0), 1)


def test_a_board_never_gets_the_same_record_card_twice(tmp_path: Path) -> None:
    # A Board accepts a record once (409 record_card_exists); the first live run hit it.
    pack = get_pack("harbor")
    seen: dict[str, set[str]] = {}

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login(request)
        if request.method == "GET":
            return _page([], request)
        body = json.loads(request.content)
        if request.url.path.endswith("/cards") and body.get("kind") == "record":
            used = seen.setdefault(request.url.path, set())
            if body["record_id"] in used:
                return httpx.Response(409, json={"detail": {"code": "record_card_exists"}})
            used.add(body["record_id"])
        return httpx.Response(201, json={"id": str(uuid5(UUID(BOARD_ID), str(body))),
                                         "revision": 1})  # fmt: skip

    client = _client(tmp_path, "admin", respond)
    # Few records and many cards: without care, the draw repeats a record.
    records = {f"service_requests:{n:06d}": {"id": _uuid("record", n)} for n in range(1, 4)}
    records |= {key: {"id": _uuid(key)} for key in
                ("customers:000001", "customers:000003", "quotes:000001", "quotes:000002")}
    boards = {
        name: {"id": _uuid("board", name), "logical_id": name, "scope": "department",
               "department_key": name.split(":")[1], "authors": ("admin",), "board": {}}
        for name in ("department:sales", "department:service")
    }  # fmt: skip

    counts = seed_kanban(client, boards=boards, clients={"admin": client}, records=records,
                         anchor_date=ANCHOR, organization=pack)  # fmt: skip

    assert counts["kanban_cards"] == 24
    service = seen[f"/api/boards/{_uuid('board', 'department:service')}/cards"]
    assert len(service) == 3  # Every record once; the other cards are objectives.
    client.close()
