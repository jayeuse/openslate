"""Record cards: per-viewer summaries, locked cards that leak nothing, and card activity."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.models import AccessLevel
from app.systems.boards.kanban_models import (
    BoardCard,
    BoardCardChecklistItem,
    BoardCardLabel,
    BoardLabel,
    BoardStage,
)
from app.systems.manage.audit.listeners import REALTIME_INVALIDATION_KEY
from app.systems.manage.audit.models import AuditAction, AuditLog
from tests.boards.kanban_support import (
    Source,
    add_objective,
    add_record_card,
    add_stage,
    kanban,
    record_source,
)
from tests.boards.support import department_board, grant, member, project_board
from tests.rbac.support import make_group_access

pytestmark = pytest.mark.integration

SUMMARY_SECRETS = ("Quotes", "Harbor crane quote", "Rosa", "Sent", "Private notes", "North")


def _assert_nothing_of(source: Source, text: str) -> None:
    for secret in (*SUMMARY_SECRETS, str(source.record.id), str(source.module.id),
                   *(str(field.id) for field in source.fields.values())):
        assert secret not in text, secret


def _expected(source: Source, title: str = "Harbor crane quote") -> dict[str, object]:
    fields = source.fields
    return {
        "locked": False, "record_id": str(source.record.id), "module_id": str(source.module.id),
        "module_name": "Quotes", "title": title,
        "fields": [
            {"field_id": str(fields["Owner"].id), "name": "Owner", "value": "Rosa"},
            {"field_id": str(fields["Quoted on"].id), "name": "Quoted on",
             "value": "2026-10-01"},
        ],
        "status": {"field_id": str(fields["Stage"].id), "name": "Stage", "value": "Sent"},
    }


def test_record_card_summary_is_computed_for_each_viewer_at_read_time(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    writer, sees, blind = member(db), member(db), member(db)
    board = project_board(db)
    grant(db, board, [writer], AccessLevel.WRITE)
    grant(db, board, [sees, blind], AccessLevel.READ)
    stage = add_stage(db, board)
    source = record_source(db, writer)
    seen_grant = make_group_access(db, [sees], source.department, source.module)
    db.commit()
    root = f"/api/boards/{board.id}/cards"
    created = kanban(db, writer).post(
        root, json={"kind": "record", "stage_id": str(stage.id),
                    "record_id": str(source.record.id), "due_on": "2026-11-20"},
    )
    assert created.status_code == 201, created.text
    card_id = created.json()["id"]
    assert created.json()["record"] == _expected(source)
    assert created.json()["title"] is None

    assert kanban(db, sees).get(root).json()["items"][0]["record"] == _expected(source)
    for path in (root, f"{root}/{card_id}", f"{root}/{card_id}/activity"):
        response = kanban(db, blind).get(path)
        assert response.status_code == 200, response.text
        _assert_nothing_of(source, response.text)
    locked = kanban(db, blind).get(f"{root}/{card_id}").json()
    assert locked["record"] == {"locked": True}
    assert (locked["kind"], locked["due_on"], locked["stage_id"]) == (
        "record", "2026-11-20", str(stage.id),
    )

    source.record.data = {**source.record.data, str(source.fields["Title"].id): "Renamed"}
    db.commit()
    assert kanban(db, sees).get(f"{root}/{card_id}").json()["record"]["title"] == "Renamed"
    seen_grant.is_deleted = True
    db.commit()
    assert kanban(db, sees).get(f"{root}/{card_id}").json()["record"] == {"locked": True}

    source.record.is_deleted, source.record.deleted_at = True, datetime.now(UTC)
    db.commit()
    trashed = kanban(db, writer).get(f"{root}/{card_id}")
    assert trashed.json()["record"] == {"locked": True}
    _assert_nothing_of(source, trashed.text)


def test_a_record_card_needs_record_read_and_one_active_card_per_record(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    writer = member(db)
    board = project_board(db)
    grant(db, board, [writer], AccessLevel.WRITE)
    stage = add_stage(db, board)
    source = record_source(db)
    db.commit()
    root = f"/api/boards/{board.id}/cards"
    body = {"kind": "record", "stage_id": str(stage.id), "record_id": str(source.record.id)}
    api = kanban(db, writer)
    unreadable = api.post(root, json=body)
    assert unreadable.status_code == 409
    assert unreadable.json()["detail"]["code"] == "record_unavailable"
    _assert_nothing_of(source, unreadable.text)
    assert db.scalar(select(BoardCard.id).where(BoardCard.board_id == board.id)) is None

    make_group_access(db, [writer], source.department, source.module)
    db.commit()
    first = api.post(root, json=body)
    assert first.status_code == 201, first.text
    duplicate = api.post(root, json=body)
    assert duplicate.json()["detail"]["code"] == "record_card_exists"
    archived = api.post(f"{root}/{first.json()['id']}/archive", json={"revision": 1})
    assert archived.status_code == 200
    second = api.post(root, json=body)
    assert second.status_code == 201, second.text
    restore = api.post(f"{root}/{first.json()['id']}/restore", json={"revision": 2})
    assert restore.json()["detail"]["code"] == "record_card_exists"
    titled = api.patch(f"{root}/{second.json()['id']}", json={"revision": 1, "title": "No"})
    assert titled.json()["detail"]["code"] == "record_card_fields"


def test_writers_move_and_archive_a_locked_card_and_change_nothing_else(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    writer, reader = member(db), member(db)
    board = project_board(db)
    grant(db, board, [writer], AccessLevel.WRITE)
    grant(db, board, [reader], AccessLevel.READ)
    todo, done = add_stage(db, board, "To do", 0), add_stage(db, board, "Done", 1)
    source = record_source(db, reader)
    card = add_record_card(db, board, todo, source.record, 1024)
    db.commit()
    root = f"/api/boards/{board.id}/cards"
    path = f"{root}/{card.id}"
    api = kanban(db, writer)

    moved = api.patch(path, json={"revision": 1, "stage_id": str(done.id)})
    assert moved.status_code == 200, moved.text
    assert moved.json()["record"] == {"locked": True}
    _assert_nothing_of(source, moved.text)
    for change in ({"assignee_id": str(reader.id)}, {"due_on": "2026-12-01"},
                   {"label_ids": []}):
        refused = api.patch(path, json={"revision": 2, **change})
        assert refused.status_code == 403, change
        assert refused.json()["detail"]["code"] == "record_locked"
    batch = api.post(f"{root}/batch-dates", json={"items": [
        {"card_id": str(card.id), "revision": 2, "start_on": None, "due_on": "2026-12-01"},
    ]})
    assert batch.json() == {"results": [{"status": "forbidden", "card_id": str(card.id)}]}
    assert api.get(root, params={"search": "Harbor"}).json()["items"] == []
    assert [item["id"] for item in kanban(db, reader).get(
        root, params={"search": "Harbor"}).json()["items"]] == [str(card.id)]
    archived = api.post(f"{path}/archive", json={"revision": 2})
    assert archived.status_code == 200
    restored = api.post(f"{path}/restore", json={"revision": 3})
    assert restored.status_code == 200
    for response in (archived, restored, batch):
        _assert_nothing_of(source, response.text)


def test_card_activity_lists_allowlisted_changes_from_the_audit_log(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    writer, reader, outsider = member(db), member(db), member(db)
    board = project_board(db)
    grant(db, board, [writer], AccessLevel.WRITE)
    grant(db, board, [reader], AccessLevel.READ)
    todo, doing = add_stage(db, board, "To do", 0), add_stage(db, board, "Doing", 1)
    add_objective(db, board, doing, "Low", 1)
    add_objective(db, board, doing, "High", 2)
    label = BoardLabel(org_id=board.org_id, board_id=board.id, name="Urgent",
                       color="chart-1", position=0)
    db.add(label)
    db.commit()
    root = f"/api/boards/{board.id}/cards"
    api = kanban(db, writer)
    card = api.post(root, json={"kind": "objective", "stage_id": str(todo.id),
                                "title": "Secret plan"}).json()
    path = f"{root}/{card['id']}"
    api.patch(path, json={"revision": 1, "stage_id": str(doing.id), "position": 1})
    api.patch(path, json={"revision": 2, "label_ids": [str(label.id)]})
    item = api.post(f"{path}/checklist", json={"text": "Hidden step"}).json()
    api.patch(f"/api/boards/{board.id}/checklist/{item['id']}",
              json={"revision": 1, "done": True})
    api.patch(path, json={"revision": 3, "due_on": "2026-11-30"})
    api.post(f"{path}/archive", json={"revision": 4})

    activity = kanban(db, reader).get(f"{path}/activity")
    assert activity.status_code == 200, activity.text
    assert [(row["kind"], row["summary"]) for row in activity.json()["items"]] == [
        ("card", "Card archived"),
        ("card", "Dates changed"),
        ("checklist", "Checklist item done"),
        ("checklist", "Checklist item added"),
        ("label", "Label added"),
        ("card", "Card moved"),
        ("card", "Card added"),
    ]
    assert set(activity.json()["items"][0]) == {
        "id", "created_at", "kind", "action", "summary", "actor_label",
    }
    assert "Secret plan" not in activity.text and "Hidden step" not in activity.text
    # The move renumbered "High"; a rank-only change is not activity.
    high = db.scalar(select(BoardCard).where(BoardCard.title == "High",
                                             BoardCard.board_id == board.id))
    assert high is not None and high.rank == 3072
    high_activity = kanban(db, reader).get(f"{root}/{high.id}/activity").json()["items"]
    assert [row["summary"] for row in high_activity] == ["Card added"]
    assert kanban(db, outsider).get(f"{path}/activity").status_code == 404
    other = project_board(db)
    grant(db, other, [reader], AccessLevel.READ)
    db.commit()
    assert kanban(db, reader).get(
        f"/api/boards/{other.id}/cards/{card['id']}/activity"
    ).status_code == 404


def test_kanban_rows_carry_their_department_and_invalidate_their_board(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board = department_board(db)
    db.commit()
    db.info.pop(REALTIME_INVALIDATION_KEY, None)
    stage = BoardStage(org_id=board.org_id, board_id=board.id, name="To do", position=0)
    label = BoardLabel(org_id=board.org_id, board_id=board.id, name="Urgent",
                       color="chart-1", position=0)
    db.add_all((stage, label))
    db.flush()
    card = add_objective(db, board, stage, "Inspect", 1024)
    applied = BoardCardLabel(org_id=board.org_id, board_id=board.id, card_id=card.id,
                             label_id=label.id)
    step = BoardCardChecklistItem(org_id=board.org_id, board_id=board.id, card_id=card.id,
                                  text="Look", position=0)
    db.add_all((applied, step))
    db.flush()
    for row in (stage, label, card, applied, step):
        log = db.scalar(select(AuditLog).where(
            AuditLog.entity_type == row.__tablename__, AuditLog.entity_id == row.id,
            AuditLog.action == AuditAction.CREATE,
        ))
        assert log is not None and log.department_id == board.department_id, row
    payloads = {
        tuple(sorted(event.to_payload().items()))
        for event in db.info.get(REALTIME_INVALIDATION_KEY, [])
        if event.entity.startswith("board_")
    }
    assert payloads == {
        (("board_id", str(board.id)), ("entity", entity))
        for entity in ("board_stages", "board_labels", "board_cards")
    }
