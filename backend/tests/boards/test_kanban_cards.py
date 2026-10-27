"""Kanban cards: writers add, move, archive and date them; ranks stay strictly ordered."""

from datetime import UTC, date, datetime
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.models import AccessLevel
from app.systems.boards.kanban_models import BoardCard, BoardCardChecklistItem, BoardLabel
from tests.boards.kanban_support import add_objective, add_stage, kanban
from tests.boards.support import grant, guest, member, project_board

pytestmark = pytest.mark.integration


def _world(db: Session):
    writer, reader, outsider, capped = member(db), member(db), member(db), guest(db)
    board = project_board(db)
    grant(db, board, [writer, capped], AccessLevel.WRITE)
    grant(db, board, [reader], AccessLevel.READ)
    todo, doing = add_stage(db, board, "To do", 0), add_stage(db, board, "Doing", 1)
    return board, todo, doing, writer, reader, outsider, capped


def _ranks(db: Session, stage_id: UUID) -> list[tuple[str | None, int]]:
    rows = db.scalars(
        select(BoardCard)
        .where(BoardCard.stage_id == stage_id, BoardCard.archived_at.is_(None))
        .order_by(BoardCard.rank)
    )
    return [(row.title, row.rank) for row in rows]


def test_writers_add_objectives_at_the_end_or_a_position_and_readers_only_read(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board, todo, _doing, writer, reader, outsider, capped = _world(db)
    db.commit()
    root = f"/api/boards/{board.id}/cards"
    body = {"kind": "objective", "stage_id": str(todo.id), "title": "Call the harbor"}
    for denied in (reader, capped):
        assert kanban(db, denied).post(root, json=body).status_code == 403
    assert kanban(db, outsider).post(root, json=body).status_code == 404
    api = kanban(db, writer)
    first = api.post(root, json={**body, "description": "Ask about cranes",
                                 "start_on": "2026-11-02", "due_on": "2026-11-06",
                                 "assignee_id": str(reader.id)})
    assert first.status_code == 201, first.text
    created = first.json()
    assert first.headers["Location"] == f"{root}/{created['id']}"
    assert {key: created[key] for key in (
        "kind", "title", "description", "rank", "assignee_id", "start_on", "due_on",
        "label_ids", "checklist", "checklist_items", "record", "revision", "archived_at",
    )} == {
        "kind": "objective", "title": "Call the harbor", "description": "Ask about cranes",
        "rank": 1024, "assignee_id": str(reader.id), "start_on": "2026-11-02",
        "due_on": "2026-11-06", "label_ids": [], "checklist": {"done": 0, "total": 0},
        "checklist_items": [], "record": None, "revision": 1, "archived_at": None,
    }
    api.post(root, json={**body, "title": "Second"})
    api.post(root, json={**body, "title": "Top", "position": 0})
    assert _ranks(db, todo.id) == [("Top", 512), ("Call the harbor", 1024), ("Second", 2048)]
    read = kanban(db, reader).get(f"{root}/{created['id']}")
    assert read.status_code == 200 and read.json()["description"] == "Ask about cranes"
    assert kanban(db, outsider).get(f"{root}/{created['id']}").status_code == 404


@pytest.mark.parametrize(
    ("change", "code"),
    [
        pytest.param({"stage": "archived"}, "stage_unavailable", id="archived-stage"),
        pytest.param({"stage": "foreign"}, "stage_unavailable", id="stage-of-another-board"),
        pytest.param({"label": "foreign"}, "label_unavailable", id="label-of-another-board"),
        pytest.param({"assignee": "outsider"}, "assignee_unavailable", id="assignee-cannot-read"),
    ],
)
def test_card_references_must_belong_to_the_board(
    integration_owner_db: Session, change: dict[str, str], code: str
) -> None:
    db = integration_owner_db
    board, todo, _doing, writer, _reader, outsider, _capped = _world(db)
    other = project_board(db)
    stage = todo
    if change.get("stage") == "archived":
        stage = add_stage(db, board, "Old", 5, archived_at=datetime.now(UTC))
    elif change.get("stage") == "foreign":
        stage = add_stage(db, other, "Elsewhere")
    body: dict[str, object] = {"kind": "objective", "stage_id": str(stage.id), "title": "x"}
    if change.get("label"):
        label = BoardLabel(org_id=other.org_id, board_id=other.id, name="Theirs",
                           color="chart-1", position=0)
        db.add(label)
        db.flush()
        body["label_ids"] = [str(label.id)]
    if change.get("assignee"):
        body["assignee_id"] = str(outsider.id)
    db.commit()
    refused = kanban(db, writer).post(f"/api/boards/{board.id}/cards", json=body)
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["code"] == code
    assert db.scalar(select(BoardCard.id).where(BoardCard.board_id == board.id)) is None


def test_one_request_moves_a_card_and_a_full_gap_renumbers_the_stage(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board, todo, doing, writer, *_ = _world(db)
    first = add_objective(db, board, doing, "First", 1)
    add_objective(db, board, doing, "Second", 2)
    moving = add_objective(db, board, todo, "Moving", 1024)
    db.commit()
    path = f"/api/boards/{board.id}/cards/{moving.id}"
    api = kanban(db, writer)
    moved = api.patch(path, json={"revision": 1, "stage_id": str(doing.id), "position": 1})
    assert moved.status_code == 200, moved.text
    assert (moved.json()["stage_id"], moved.json()["revision"]) == (str(doing.id), 2)
    # No integer fits between ranks 1 and 2, so the stage is renumbered in order.
    assert _ranks(db, doing.id) == [("First", 1024), ("Moving", 2048), ("Second", 3072)]
    assert _ranks(db, todo.id) == []
    assert db.get(BoardCard, first.id).revision == 1
    stale = api.patch(path, json={"revision": 1, "position": 0})
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "stale_card_revision"
    assert stale.json()["detail"]["current_revision"] == 2
    to_top = api.patch(path, json={"revision": 2, "position": 0})
    assert to_top.status_code == 200
    assert _ranks(db, doing.id) == [("Moving", 512), ("First", 1024), ("Second", 3072)]
    start_only = api.patch(path, json={"revision": 3, "start_on": "2026-12-01"})
    assert start_only.status_code == 200
    reversed_dates = api.patch(path, json={"revision": 4, "due_on": "2026-11-01"})
    assert reversed_dates.status_code == 422
    assert reversed_dates.json()["detail"]["code"] == "card_dates_invalid"


def test_card_lists_filter_by_stage_assignee_label_due_window_search_and_archive(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board, todo, doing, writer, reader, *_ = _world(db)
    label = BoardLabel(org_id=board.org_id, board_id=board.id, name="Urgent",
                       color="chart-1", position=0)
    db.add(label)
    mine = add_objective(db, board, todo, "Fix the gate", 1024, assignee_id=reader.id,
                         due_on=date(2026, 11, 2))
    add_objective(db, board, todo, "Paint the shed", 2048, due_on=date(2026, 11, 9))
    add_objective(db, board, doing, "Order fuel", 1024, due_on=date(2026, 11, 3))
    add_objective(db, board, doing, "Old task", 2048,
                  archived_at=datetime.now(UTC))
    db.commit()
    api = kanban(db, writer)
    labelled = api.patch(f"/api/boards/{board.id}/cards/{mine.id}",
                         json={"revision": 1, "label_ids": [str(label.id)]})
    assert labelled.status_code == 200, labelled.text
    root = f"/api/boards/{board.id}/cards"

    def titles(**params: object) -> list[str]:
        response = kanban(db, reader).get(root, params=params)
        assert response.status_code == 200, response.text
        return [item["title"] for item in response.json()["items"]]

    assert titles(stage_id=str(todo.id)) == ["Fix the gate", "Paint the shed"]
    assert titles(assignee="me") == ["Fix the gate"]
    assert titles(assignee=str(writer.id)) == []
    assert titles(label=[str(label.id)]) == ["Fix the gate"]
    assert titles(due_from="2026-11-03", due_to="2026-11-09", sort_by="due_on") == [
        "Order fuel", "Paint the shed",
    ]
    assert titles(search="fuel") == ["Order fuel"]
    assert titles(archived="true") == ["Old task"]
    page = kanban(db, reader).get(root, params={"stage_id": str(todo.id), "limit": 1}).json()
    assert page["pagination"] == {"limit": 1, "offset": 0, "count": 1, "total": 2,
                                  "has_more": True}


def test_archived_cards_restore_to_the_end_of_an_active_stage(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board, todo, doing, writer, *_ = _world(db)
    card = add_objective(db, board, todo, "Seasonal", 1024)
    add_objective(db, board, doing, "Already here", 1024)
    db.commit()
    path = f"/api/boards/{board.id}/cards/{card.id}"
    api = kanban(db, writer)
    archived = api.post(f"{path}/archive", json={"revision": 1})
    assert archived.status_code == 200 and archived.json()["archived_at"] is not None
    assert api.patch(path, json={"revision": 2, "title": "Edit"}).json()["detail"]["code"] == (
        "card_archived"
    )
    todo.archived_at = datetime.now(UTC)
    db.commit()
    refused = api.post(f"{path}/restore", json={"revision": 2})
    assert refused.json()["detail"]["code"] == "stage_unavailable"
    restored = api.post(f"{path}/restore", json={"revision": 2, "stage_id": str(doing.id)})
    assert restored.status_code == 200, restored.text
    assert restored.json()["archived_at"] is None and restored.json()["revision"] == 3
    assert _ranks(db, doing.id) == [("Already here", 1024), ("Seasonal", 2048)]
    again = api.post(f"{path}/restore", json={"revision": 3})
    assert again.json()["detail"]["code"] == "card_not_archived"


def test_checklists_belong_to_objectives_and_report_progress(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board, todo, _doing, writer, reader, *_ = _world(db)
    card = add_objective(db, board, todo, "Prepare berth", 1024)
    db.commit()
    root = f"/api/boards/{board.id}"
    api = kanban(db, writer)
    added = [api.post(f"{root}/cards/{card.id}/checklist", json={"text": text}).json()
             for text in ("Ropes", "Fenders", "Lights")]
    assert [item["position"] for item in added] == [0, 1, 2]
    assert kanban(db, reader).post(f"{root}/cards/{card.id}/checklist",
                                   json={"text": "No"}).status_code == 403
    ticked = api.patch(f"{root}/checklist/{added[0]['id']}", json={"revision": 1, "done": True})
    assert ticked.json()["done"] is True and ticked.json()["revision"] == 2
    stale = api.patch(f"{root}/checklist/{added[0]['id']}", json={"revision": 1, "text": "x"})
    assert stale.json()["detail"]["code"] == "stale_checklist_revision"
    ordered = api.put(f"{root}/cards/{card.id}/checklist/order",
                      json={"item_ids": [added[2]["id"], added[0]["id"], added[1]["id"]]})
    assert [item["text"] for item in ordered.json()["items"]] == ["Lights", "Ropes", "Fenders"]
    partial = api.put(f"{root}/cards/{card.id}/checklist/order",
                      json={"item_ids": [added[0]["id"]]})
    assert partial.json()["detail"]["code"] == "checklist_order_stale"
    removed = api.request("DELETE", f"{root}/checklist/{added[1]['id']}", json={"revision": 1})
    assert removed.status_code == 204
    listed = kanban(db, reader).get(f"{root}/cards").json()["items"][0]
    assert listed["checklist"] == {"done": 1, "total": 2}
    detail = kanban(db, reader).get(f"{root}/cards/{card.id}").json()
    assert [item["text"] for item in detail["checklist_items"]] == ["Lights", "Ropes"]

    for position in range(48):
        db.add(BoardCardChecklistItem(org_id=board.org_id, board_id=board.id, card_id=card.id,
                                      text=f"Item {position}", position=10 + position))
    db.commit()
    over = api.post(f"{root}/cards/{card.id}/checklist", json={"text": "Fifty-one"})
    assert over.status_code == 409 and over.json()["detail"]["code"] == "checklist_limit"


def test_gantt_batch_dates_report_updated_stale_and_forbidden_per_card(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board, todo, _doing, writer, reader, *_ = _world(db)
    fresh = add_objective(db, board, todo, "Fresh", 1024)
    old = add_objective(db, board, todo, "Old", 2048, revision=3)
    gone = add_objective(db, board, todo, "Gone", 3072, archived_at=datetime.now(UTC))
    other_board = project_board(db)
    elsewhere = add_objective(db, other_board, add_stage(db, other_board), "Elsewhere", 1024)
    db.commit()
    path = f"/api/boards/{board.id}/cards/batch-dates"
    items = [
        {"card_id": str(fresh.id), "revision": 1, "start_on": "2026-11-02",
         "due_on": "2026-11-04"},
        {"card_id": str(old.id), "revision": 1, "start_on": None, "due_on": "2026-11-05"},
        {"card_id": str(gone.id), "revision": 1, "start_on": None, "due_on": None},
        {"card_id": str(elsewhere.id), "revision": 1, "start_on": None, "due_on": None},
    ]
    assert kanban(db, reader).post(path, json={"items": items}).status_code == 403
    response = kanban(db, writer).post(path, json={"items": items})
    assert response.status_code == 200, response.text
    assert response.json() == {"results": [
        {"status": "updated", "card_id": str(fresh.id), "revision": 2,
         "start_on": "2026-11-02", "due_on": "2026-11-04"},
        {"status": "stale", "card_id": str(old.id)},
        {"status": "forbidden", "card_id": str(gone.id)},
        {"status": "forbidden", "card_id": str(elsewhere.id)},
    ]}
    db.expire_all()
    assert (db.get(BoardCard, old.id).due_on, db.get(BoardCard, elsewhere.id).revision) == (
        None, 1,
    )
