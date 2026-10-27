"""Kanban stages and labels: managers own them, others read them, limits hold."""

from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.models import AccessLevel
from app.systems.boards.kanban_models import BoardCard, BoardCardLabel, BoardLabel, BoardStage
from tests.boards.kanban_support import (
    add_objective,
    add_record_card,
    add_stage,
    kanban,
    record_source,
)
from tests.boards.support import grant, guest, member, project_board

pytestmark = pytest.mark.integration


def _people(db: Session):
    manager, writer, reader, outsider = member(db), member(db), member(db), member(db)
    capped = guest(db)
    board = project_board(db)
    grant(db, board, [manager, capped], AccessLevel.MANAGE)
    grant(db, board, [writer], AccessLevel.WRITE)
    grant(db, board, [reader], AccessLevel.READ)
    return board, manager, writer, reader, outsider, capped


def test_only_managers_add_change_and_order_stages_and_readers_list_them(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board, manager, writer, reader, outsider, capped = _people(db)
    db.commit()
    root = f"/api/boards/{board.id}/stages"
    for denied in (writer, reader, capped):
        assert kanban(db, denied).post(root, json={"name": "To do"}).status_code == 403
    assert kanban(db, outsider).post(root, json={"name": "To do"}).status_code == 404
    assert kanban(db, outsider).get(root).status_code == 404

    api = kanban(db, manager)
    todo = api.post(root, json={"name": "To do", "color": "chart-1", "wip_limit": 3})
    assert todo.status_code == 201, todo.text
    assert todo.json() | {"id": None, "archived_at": None} == {
        "id": None, "board_id": str(board.id), "name": "To do", "color": "chart-1",
        "wip_limit": 3, "card_sort": "manual", "position": 0, "revision": 1,
        "archived_at": None, "card_count": 0,
    }
    doing = api.post(root, json={"name": "Doing"}).json()
    done = api.post(root, json={"name": "Done"}).json()
    assert [doing["position"], done["position"]] == [1, 2]

    changed = api.patch(
        f"{root}/{doing['id']}",
        json={"revision": 1, "name": "In progress", "wip_limit": None, "card_sort": "due"},
    )
    assert changed.status_code == 200, changed.text
    assert (changed.json()["name"], changed.json()["card_sort"]) == ("In progress", "due")
    assert changed.json()["revision"] == 2
    stale = api.patch(f"{root}/{doing['id']}", json={"revision": 1, "name": "Late"})
    assert stale.status_code == 409
    assert stale.json()["detail"] == {
        "code": "stale_stage_revision",
        "message": "Changed by someone else; reload before saving",
        "current_revision": 2,
    }

    ordered = api.put(
        f"{root}/order", json={"stage_ids": [done["id"], todo.json()["id"], doing["id"]]}
    )
    assert ordered.status_code == 200, ordered.text
    assert [item["name"] for item in ordered.json()["items"]] == ["Done", "To do", "In progress"]
    missing = api.put(f"{root}/order", json={"stage_ids": [done["id"], doing["id"]]})
    assert missing.json()["detail"]["code"] == "stage_order_stale"
    listed = kanban(db, reader).get(root)
    assert listed.status_code == 200
    assert [(item["name"], item["position"]) for item in listed.json()["items"]] == [
        ("Done", 0), ("To do", 1), ("In progress", 2),
    ]


def test_stage_counts_include_locked_cards_and_the_active_stage_limit_holds(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board, manager, _writer, reader, _outsider, _capped = _people(db)
    stage = add_stage(db, board)
    add_objective(db, board, stage, "Open", 1024)
    add_objective(db, board, stage, "Gone", 2048).archived_at = stage.created_at
    hidden = record_source(db)  # nobody on this Board reads it
    add_record_card(db, board, stage, hidden.record, 3072)
    for position in range(1, 20):
        add_stage(db, board, f"Stage {position}", position)
    db.commit()
    root = f"/api/boards/{board.id}/stages"
    first = kanban(db, reader).get(root, params={"limit": 1}).json()
    assert first["items"][0]["card_count"] == 2
    assert first["pagination"]["total"] == 20
    over = kanban(db, manager).post(root, json={"name": "One too many"})
    assert over.status_code == 409 and over.json()["detail"]["code"] == "stage_limit"


def test_archiving_a_stage_moves_its_cards_in_order_or_archives_them(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board, manager, *_ = _people(db)
    source, target, other = (add_stage(db, board, name, index)
                             for index, name in enumerate(("Sent", "Won", "Lost")))
    add_objective(db, board, target, "Already won", 1024)
    add_objective(db, board, source, "First", 10)
    add_objective(db, board, source, "Second", 20)
    leaving = add_objective(db, board, other, "Leaving", 10)
    db.commit()
    root = f"/api/boards/{board.id}/stages"
    api = kanban(db, manager)

    same = api.post(f"{root}/{source.id}/archive",
                    json={"revision": 1, "cards": "move", "target_stage_id": str(source.id)})
    assert same.json()["detail"]["code"] == "stage_unavailable"
    moved = api.post(f"{root}/{source.id}/archive",
                     json={"revision": 1, "cards": "move", "target_stage_id": str(target.id)})
    assert moved.status_code == 200, moved.text
    assert moved.json()["archived_at"] is not None and moved.json()["card_count"] == 0
    cards = db.scalars(
        select(BoardCard).where(BoardCard.stage_id == target.id).order_by(BoardCard.rank)
    ).all()
    assert [card.title for card in cards] == ["Already won", "First", "Second"]
    assert [card.revision for card in cards] == [1, 2, 2]
    into_archived = api.post(
        f"{root}/{other.id}/archive",
        json={"revision": 1, "cards": "move", "target_stage_id": str(source.id)},
    )
    assert into_archived.json()["detail"]["code"] == "stage_unavailable"

    archived = api.post(f"{root}/{other.id}/archive", json={"revision": 1, "cards": "archive"})
    assert archived.status_code == 200, archived.text
    db.refresh(leaving)
    assert leaving.archived_at is not None
    assert [item["name"] for item in api.get(root).json()["items"]] == ["Won"]
    assert db.get(BoardStage, source.id).archived_at is not None
    again = api.post(f"{root}/{other.id}/archive", json={"revision": 2, "cards": "archive"})
    assert again.json()["detail"]["code"] == "stage_archived"


def test_an_archived_board_refuses_kanban_changes(integration_owner_db: Session) -> None:
    db = integration_owner_db
    board, manager, *_ = _people(db)
    board.status = "archived"
    db.commit()
    refused = kanban(db, manager).post(f"/api/boards/{board.id}/stages", json={"name": "To do"})
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "board_archived"


def test_managers_own_labels_and_removing_one_takes_it_off_cards(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board, manager, writer, reader, *_ = _people(db)
    stage = add_stage(db, board)
    card = add_objective(db, board, stage, "Labelled", 1024)
    db.commit()
    root = f"/api/boards/{board.id}/labels"
    denied = kanban(db, writer).post(root, json={"name": "Urgent", "color": "chart-2"})
    assert denied.status_code == 403
    api = kanban(db, manager)
    urgent = api.post(root, json={"name": "Urgent", "color": "chart-2"})
    assert urgent.status_code == 201, urgent.text
    assert urgent.json()["position"] == 0 and urgent.json()["revision"] == 1
    taken = api.post(root, json={"name": "urgent", "color": "chart-3"})
    assert taken.json()["detail"]["code"] == "label_name_taken"
    blocked = api.post(root, json={"name": "Blocked", "color": "chart-4"}).json()
    renamed = api.patch(f"{root}/{blocked['id']}", json={"revision": 1, "name": "URGENT"})
    assert renamed.json()["detail"]["code"] == "label_name_taken"
    recolored = api.patch(f"{root}/{blocked['id']}", json={"revision": 1, "color": "chart-5"})
    assert recolored.json()["color"] == "chart-5" and recolored.json()["revision"] == 2

    applied = kanban(db, writer).patch(
        f"/api/boards/{board.id}/cards/{card.id}",
        json={"revision": 1, "label_ids": [urgent.json()["id"], blocked["id"]]},
    )
    assert applied.status_code == 200, applied.text
    assert set(applied.json()["label_ids"]) == {urgent.json()["id"], blocked["id"]}
    stale = api.request("DELETE", f"{root}/{blocked['id']}", json={"revision": 1})
    assert stale.json()["detail"]["code"] == "stale_label_revision"
    removed = api.request("DELETE", f"{root}/{blocked['id']}", json={"revision": 2})
    assert removed.status_code == 204
    remaining = select(BoardCardLabel.label_id).where(BoardCardLabel.card_id == card.id)
    assert db.scalars(remaining).all() == [UUID(urgent.json()["id"])]
    assert [item["name"] for item in kanban(db, reader).get(root).json()["items"]] == ["Urgent"]


def test_a_board_holds_at_most_twenty_labels(integration_owner_db: Session) -> None:
    db = integration_owner_db
    board, manager, *_ = _people(db)
    for index in range(20):
        db.add(BoardLabel(org_id=board.org_id, board_id=board.id, name=f"Label {index}",
                          color="chart-1", position=index))
    db.commit()
    over = kanban(db, manager).post(
        f"/api/boards/{board.id}/labels", json={"name": "Extra", "color": "chart-1"}
    )
    assert over.status_code == 409 and over.json()["detail"]["code"] == "label_limit"
