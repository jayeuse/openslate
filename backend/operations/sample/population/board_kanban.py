"""Kanbans and calendar sources on department Boards through the Board UI APIs (spec R9).

The administrator (a manager of every Board) adds the stages, labels and Board calendar
sources; a team member who writes on the Board adds the cards and their checklists, as
people do in the UI. The pack's own demo Kanban keeps its named cards. Every other
department Board gets a Kanban with the department's stages, and the number of cards
grows with the profile. Record cards point at seeded records the team member reads;
dates follow the run's anchor date.
"""

from __future__ import annotations

import random
from collections.abc import Mapping, Sequence
from datetime import date, timedelta
from importlib import import_module
from typing import Any

from operations.sample.client import SampleClient, SampleClientError
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.registry import default_pack
from operations.sample.population.content import SampleContentError, _id, _json, _pages

KANBAN_KEYS = (
    "kanban_stages",
    "kanban_labels",
    "kanban_cards",
    "kanban_checklist_items",
    "calendar_sources",
)
DEFAULT_LABELS = (("Urgent", "chart-1"), ("Waiting", "chart-2"), ("Follow-up", "chart-3"))
# Cards on each department Board: Small 12, Standard 24, Large 60 (spec R9).
CARD_TARGETS = ((2_000, 12), (10_000, 24))
LARGE_CARDS = 60


def card_target(record_count: int) -> int:
    """The profile's card count, read from the size of the seeded organization."""
    return next((cards for limit, cards in CARD_TARGETS if record_count < limit), LARGE_CARDS)


def _pack_realism(pack: OrganizationPack) -> Any:
    try:
        return import_module(f"operations.sample.packs.{pack.identity.key}.realism")
    except ModuleNotFoundError:
        return None


def seed_kanban(
    admin: SampleClient,
    *,
    boards: Mapping[str, Mapping[str, Any]],
    clients: Mapping[str, SampleClient],
    records: Mapping[str, Mapping[str, Any]],
    anchor_date: date,
    organization: OrganizationPack | None = None,
) -> dict[str, int]:
    """Seed every department Board's Kanban and calendar sources; a pack without data seeds
    only its demo Kanban, or nothing."""

    counts = dict.fromkeys(KANBAN_KEYS, 0)
    pack = organization or default_pack()
    spec = pack.content.data.kanban
    realism = _pack_realism(pack)
    target = card_target(len(records))
    seeded: set[str] = set()
    if spec is not None:
        board = boards.get(spec.board)
        if board is None or board.get("department_key") is None:
            raise SampleContentError(f"Kanban Board is unavailable: {spec.board}")
        _seed_spec_board(admin, board, spec, clients, records, anchor_date, counts)
        seeded.add(spec.board)
        stages = _ids(admin, board, "stages")
        if realism is not None and len(spec.cards) < target:
            _generate_cards(pack, board, stages, _ids(admin, board, "labels"), clients, records,
                            anchor_date, target - len(spec.cards), counts)  # fmt: skip
    if realism is None:
        return counts
    modules = _pages(admin, "/api/modules")
    for logical_id, board in boards.items():
        department = board.get("department_key")
        if department is None or board.get("scope") != "department":
            continue
        if logical_id not in seeded:
            stages = [
                _create(admin, board, "stages", f"{logical_id}:stage", index, name, None)
                for index, name in enumerate(realism.BOARD_STAGES[department])
            ]
            labels = [
                _create(admin, board, "labels", f"{logical_id}:label", index, name, color)
                for index, (name, color) in enumerate(DEFAULT_LABELS)
            ]
            counts["kanban_stages"] += len(stages)
            counts["kanban_labels"] += len(labels)
            _generate_cards(pack, board, stages, labels, clients, records, anchor_date, target,
                            counts)  # fmt: skip
        _seed_calendar_sources(admin, pack, board, modules, clients, counts)
    return counts


def _create(
    admin: SampleClient,
    board: Mapping[str, Any],
    kind: str,
    logical: str,
    index: int,
    name: str,
    color: str | None,
) -> str:
    row = _json(admin, "POST", f"/api/boards/{board['id']}/{kind}",
                body={"name": name, "color": color}, expected=(201,))  # fmt: skip
    admin.record_mapping(f"kanban_{kind}", f"{logical}:{index + 1:02d}", _id(row))
    return _id(row)


def _ids(admin: SampleClient, board: Mapping[str, Any], kind: str) -> list[str]:
    return [_id(row) for row in _pages(admin, f"/api/boards/{board['id']}/{kind}")]


def _seed_spec_board(
    admin: SampleClient,
    board: Mapping[str, Any],
    spec: Any,
    clients: Mapping[str, SampleClient],
    records: Mapping[str, Mapping[str, Any]],
    anchor_date: date,
    counts: dict[str, int],
) -> None:
    """The pack's named demo cards; a dated card starts a week or two before it is due."""
    writer = clients[board["authors"][0]]
    base = f"/api/boards/{board['id']}"
    stage_ids = [
        _create(admin, board, "stages", f"{spec.board}:stage", index, name, color)
        for index, (name, color) in enumerate(spec.stages)
    ]
    label_ids = [
        _create(admin, board, "labels", f"{spec.board}:label", index, name, color)
        for index, (name, color) in enumerate(spec.labels)
    ]
    for index, item in enumerate(spec.cards):
        body: dict[str, Any] = {
            "stage_id": stage_ids[item.stage],
            "label_ids": [label_ids[label] for label in item.labels],
        }
        if item.due_in_days is not None:
            due = anchor_date + timedelta(days=item.due_in_days)
            start = due - timedelta(days=7 + index % 8)
            body.update(start_on=start.isoformat(), due_on=due.isoformat())
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
    counts["kanban_stages"] += len(stage_ids)
    counts["kanban_labels"] += len(label_ids)
    counts["kanban_cards"] += len(spec.cards)


def _generate_cards(
    pack: OrganizationPack,
    board: Mapping[str, Any],
    stages: Sequence[str],
    labels: Sequence[str],
    clients: Mapping[str, SampleClient],
    records: Mapping[str, Mapping[str, Any]],
    anchor_date: date,
    count: int,
    counts: dict[str, int],
) -> None:
    """Cards spread over the stages: many finished, some overdue, a few archived."""
    department = board["department_key"]
    logical = board["logical_id"]
    writer = clients[board["authors"][0]]
    base = f"/api/boards/{board['id']}"
    own = {module.key for module in pack.catalog.modules if module.department == department}
    record_ids = sorted(key for key in records if key.partition(":")[0] in own)
    objectives = _pack_realism(pack).BOARD_OBJECTIVES[department]
    last = len(stages) - 1
    weights = [20.0, *([45.0 / max(1, last - 1)] * max(0, last - 1)), 35.0][: len(stages)]
    for number in range(count):
        rng = random.Random(f"kanban:{pack.identity.key}:{logical}:{number}")
        stage = rng.choices(range(len(stages)), weights=weights)[0]
        start = anchor_date + timedelta(days=rng.randint(-45, 7))
        due = start + timedelta(days=rng.randint(2, 28))
        body: dict[str, Any] = {
            "stage_id": stages[stage],
            "start_on": start.isoformat(),
            "due_on": due.isoformat(),
            "label_ids": rng.sample(list(labels), k=rng.choice((0, 0, 1, 1, 2))) if labels else [],
        }
        if record_ids and rng.random() < 0.55:
            body.update(kind="record", record_id=_id(records[rng.choice(record_ids)]))
        else:
            title = objectives[number % len(objectives)]
            if number >= len(objectives):
                title = f"{title} ({rng.choice(('next term', 'follow-up', 'Q3', 'Q4', 'again'))})"
            body.update(kind="objective", title=title)
        card = _json(writer, "POST", f"{base}/cards", body=body, expected=(201,))
        card_id = _id(card)
        writer.record_mapping("kanban_cards", f"{logical}:generated:{number + 1:03d}", card_id)
        counts["kanban_cards"] += 1
        # Finished long ago: the team archives some cards in the last stage.
        if stage == last and due < anchor_date - timedelta(days=14) and rng.random() < 0.25:
            revision = card.get("revision")
            if isinstance(revision, int):
                _json(writer, "POST", f"{base}/cards/{card_id}/archive",
                      body={"revision": revision})  # fmt: skip


def _seed_calendar_sources(
    admin: SampleClient,
    pack: OrganizationPack,
    board: Mapping[str, Any],
    modules: Sequence[Mapping[str, Any]],
    clients: Mapping[str, SampleClient],
    counts: dict[str, int],
) -> None:
    """One or two of the department's module dates on its Board calendar, and a personal
    source for some team members (never the lead, whose calendar the controls use)."""
    department_id = board.get("board", {}).get("department_id")
    dated: list[dict[str, str]] = []
    for module in modules:
        if module.get("department_id") != department_id or module.get("is_deleted"):
            continue
        fields = _pages(admin, "/api/fields", {"module_id": _id(module)})
        field = next((row for row in fields if row.get("type") == "date"
                      and not row.get("is_deleted")), None)  # fmt: skip
        if field is not None:
            dated.append({"module_id": _id(module), "date_field_id": _id(field)})
    rng = random.Random(f"calendar:{pack.identity.key}:{board['logical_id']}")
    for source in dated[: rng.choice((1, 2))]:
        row = _json(admin, "POST", f"/api/boards/{board['id']}/calendar-sources", body=source,
                    expected=(201,))  # fmt: skip
        admin.record_mapping("calendar_sources", f"{board['logical_id']}:source:{_id(row)}",
                             _id(row))  # fmt: skip
        counts["calendar_sources"] += 1
    department = board["department_key"]
    lead = pack.content.data.leads.get(department)
    for key in pack.actors.team_keys.get(department, ()):
        if key == lead or key not in clients or not dated or rng.random() >= 0.3:
            continue
        try:
            _json(clients[key], "POST", "/api/me/calendar-sources", body=rng.choice(dated),
                  expected=(201,))  # fmt: skip
        except SampleClientError:
            continue  # A person who cannot read the module keeps an empty calendar.


def verify_kanban(admin: SampleClient, board_id: str) -> tuple[dict[str, int], int]:
    """One Board's Kanban and calendar sources as the administrator reads them, and the
    failed reads. Archived cards count too."""

    base = f"/api/boards/{board_id}"
    try:
        stages = _pages(admin, f"{base}/stages")
        labels = _pages(admin, f"{base}/labels")
        cards = _pages(admin, f"{base}/cards")
        cards += _pages(admin, f"{base}/cards", {"archived": "true"})
        sources = _json(admin, "GET", f"{base}/calendar-sources").get("items", [])
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
        "calendar_sources": len(sources) if isinstance(sources, list) else 0,
    }, 0
