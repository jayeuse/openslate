"""A demo Kanban on one Board through the Board's Kanban UI APIs.

The administrator (a manager of every Board) adds the stages and labels; a team member
who writes on the Board adds the cards and their checklists, as people do in the UI.
Record cards point at seeded records the team member reads; dates follow the run's
anchor date.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date, timedelta
from typing import Any

from operations.sample.client import SampleClient, SampleClientError
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.registry import default_pack
from operations.sample.population.content import SampleContentError, _id, _json, _pages

KANBAN_KEYS = ("kanban_stages", "kanban_labels", "kanban_cards", "kanban_checklist_items")


def seed_kanban(
    admin: SampleClient,
    *,
    boards: Mapping[str, Mapping[str, Any]],
    clients: Mapping[str, SampleClient],
    records: Mapping[str, Mapping[str, Any]],
    anchor_date: date,
    organization: OrganizationPack | None = None,
) -> dict[str, int]:
    """Seed the pack's demo Kanban; a pack without one seeds nothing."""

    counts = dict.fromkeys(KANBAN_KEYS, 0)
    spec = (organization or default_pack()).content.data.kanban
    if spec is None:
        return counts
    board = boards.get(spec.board)
    if board is None or board.get("department_key") is None:
        raise SampleContentError(f"Kanban Board is unavailable: {spec.board}")
    writer = clients[board["authors"][0]]
    base = f"/api/boards/{board['id']}"
    stage_ids: list[str] = []
    for index, (name, color) in enumerate(spec.stages):
        stage = _json(admin, "POST", f"{base}/stages", body={"name": name, "color": color},
                      expected=(201,))  # fmt: skip
        stage_ids.append(_id(stage))
        admin.record_mapping("kanban_stages", f"{spec.board}:stage:{index + 1:02d}", _id(stage))
    label_ids: list[str] = []
    for index, (name, color) in enumerate(spec.labels):
        label = _json(admin, "POST", f"{base}/labels", body={"name": name, "color": color},
                      expected=(201,))  # fmt: skip
        label_ids.append(_id(label))
        admin.record_mapping("kanban_labels", f"{spec.board}:label:{index + 1:02d}", _id(label))
    for index, item in enumerate(spec.cards):
        body: dict[str, Any] = {
            "stage_id": stage_ids[item.stage],
            "label_ids": [label_ids[label] for label in item.labels],
        }
        if item.due_in_days is not None:
            body["due_on"] = (anchor_date + timedelta(days=item.due_in_days)).isoformat()
        if item.record is not None:
            record = records.get(item.record)
            if record is None:
                raise SampleContentError(f"Kanban record is unavailable: {item.record}")
            body.update(kind="record", record_id=_id(record))
        else:
            body.update(kind="objective", title=item.title, description=item.description)
        card = _json(writer, "POST", f"{base}/cards", body=body, expected=(201,))
        card_id = _id(card)
        writer.record_mapping("kanban_cards", f"{spec.board}:card:{index + 1:02d}", card_id)
        for text in item.checklist:
            _json(writer, "POST", f"{base}/cards/{card_id}/checklist", body={"text": text},
                  expected=(201,))  # fmt: skip
            counts["kanban_checklist_items"] += 1
    counts["kanban_stages"] = len(stage_ids)
    counts["kanban_labels"] = len(label_ids)
    counts["kanban_cards"] = len(spec.cards)
    return counts


def verify_kanban(admin: SampleClient, board_id: str) -> tuple[dict[str, int], int]:
    """One Board's Kanban as the administrator reads it, and the failed reads."""

    base = f"/api/boards/{board_id}"
    try:
        stages = _pages(admin, f"{base}/stages")
        labels = _pages(admin, f"{base}/labels")
        cards = _pages(admin, f"{base}/cards")
    except (SampleClientError, SampleContentError):
        return dict.fromkeys(KANBAN_KEYS, 0), 1
    checklist = sum(
        int(card["checklist"]["total"])
        for card in cards
        if isinstance(card.get("checklist"), dict)
        and isinstance(card["checklist"].get("total"), int)
    )
    return {
        "kanban_stages": len(stages),
        "kanban_labels": len(labels),
        "kanban_cards": len(cards),
        "kanban_checklist_items": checklist,
    }, 0
