"""Kanban rows in purges and stored invariants: purges remove them and never block."""

from collections.abc import Callable
from datetime import UTC, date, datetime
from secrets import token_urlsafe
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.boards import lifecycle_router
from app.systems.boards.attachment_models import BoardAttachment
from app.systems.boards.calendar_source_models import BoardCalendarSource
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.kanban_models import (
    BoardCard,
    BoardCardChecklistItem,
    BoardCardLabel,
    BoardLabel,
    BoardStage,
)
from app.systems.boards.models import Board, BoardStatus
from app.systems.boards.record_link_models import BoardRecordLink
from app.systems.platform.files.models import File
from app.systems.sandbox.lifecycle.execution import execute_lifecycle
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleOperation, LifecycleTargetType
from app.systems.sandbox.records.models import Record
from tests.boards.kanban_support import (
    Source,
    add_objective,
    add_record_card,
    add_stage,
    record_source,
)
from tests.boards.support import client as board_client
from tests.boards.support import department_board, member, project_board
from tests.boards.test_permanent_delete import _actor, _enabled
from tests.rbac.support import organization
from tests.sandbox_designs.fixtures import create_document

pytestmark = pytest.mark.integration
KANBAN = (BoardCardLabel, BoardCardChecklistItem, BoardCard, BoardLabel, BoardStage)


def _kanban(db: Session, board: Board, source: Source | None = None) -> dict[str, Any]:
    """One stage, label, objective with a label and a checklist item, and a record card."""

    stage = add_stage(db, board)
    label = BoardLabel(org_id=board.org_id, board_id=board.id, name="Urgent",
                       color="chart-1", position=0)
    db.add(label)
    db.flush()
    objective = add_objective(db, board, stage, "Plan", 1024)
    rows: dict[str, Any] = {"stage": stage, "label": label, "objective": objective}
    if source is not None:
        rows["record_card"] = add_record_card(db, board, stage, source.record, 2048)
    for card in rows.values():
        if isinstance(card, BoardCard):
            db.add(BoardCardLabel(org_id=board.org_id, board_id=board.id, card_id=card.id,
                                  label_id=label.id))
            db.add(BoardCardChecklistItem(org_id=board.org_id, board_id=board.id,
                                          card_id=card.id, text="Step", position=0))
    db.flush()
    return rows


def _count(db: Session, model: type[Any], board_id: Any) -> int:
    return len(db.scalars(select(model.id).where(model.board_id == board_id)).all())


def test_project_board_purge_removes_its_kanban_and_card_owned_links(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    password = token_urlsafe(32)
    admin = _actor(db, admin=True, password=password)
    board = Board(org_id=organization(db).id, scope="project", name="Purged Kanban",
                  status=BoardStatus.ARCHIVED)
    db.add(board)
    db.flush()
    source = record_source(db)
    rows = _kanban(db, board, source)
    link = BoardRecordLink(org_id=board.org_id, board_id=board.id,
                           card_id=rows["objective"].id, record_id=source.record.id,
                           module_id=source.module.id)
    file = File(org_id=board.org_id, purpose="board_attachment", board_id=board.id,
                record_id=None, creator_id=admin.id, filename="plan.pdf", expected_size=3,
                object_key=uuid7().hex, state="awaiting_upload")
    db.add_all((link, file))
    db.flush()
    attachment = BoardAttachment(org_id=board.org_id, board_id=board.id, file_id=file.id,
                                 card_id=rows["objective"].id)
    calendar_source = BoardCalendarSource(
        org_id=board.org_id, board_id=board.id, module_id=source.module.id,
        date_field_id=source.fields["Quoted on"].id, position=0, created_by=admin.id,
    )
    db.add_all((attachment, calendar_source))
    db.commit()
    _enabled(monkeypatch, True)
    path = f"/api/boards/{board.id}/purge"
    with board_client(db, admin, lifecycle_router.router) as api:
        # The card's file blocks until its bytes are purged, as a post's file does.
        assert api.post(f"{path}/preview").status_code == 409
        attachment.is_linked = False
        file.state, file.is_deleted, file.deleted_at = "purged", True, datetime.now(UTC)
        db.commit()
        preview = api.post(f"{path}/preview")
        assert preview.status_code == 200, preview.text
        types = {row["entity_type"] for row in preview.json()["impact"]["rows"]}
        assert {"board_stages", "board_labels", "board_cards", "board_card_labels",
                "board_card_checklist_items", "board_record_links", "board_attachments",
                "files", "board_calendar_sources"} <= types
        executed = api.post(path, json={"token": preview.json()["token"],
                                        "confirmation_name": board.name,
                                        "password": password})
        assert executed.status_code == 200, executed.text
    assert db.get(Board, board.id) is None
    assert [_count(db, model, board.id) for model in KANBAN] == [0, 0, 0, 0, 0]
    assert db.get(BoardRecordLink, link.id) is None
    assert db.get(BoardAttachment, attachment.id) is None
    assert db.get(File, file.id) is None
    assert db.get(BoardCalendarSource, calendar_source.id) is None
    assert db.get(Record, source.record.id) is not None


def test_an_objectives_record_link_blocks_its_source_record_purge(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    create_document(db, organization(db))
    source = record_source(db)
    board = project_board(db)
    rows = _kanban(db, board, source)
    link = BoardRecordLink(org_id=board.org_id, board_id=board.id,
                           card_id=rows["objective"].id, record_id=source.record.id,
                           module_id=source.module.id)
    db.add(link)
    source.record.is_deleted, source.record.deleted_at = True, datetime.now(UTC)
    db.commit()

    plan = plan_lifecycle(db, LifecycleTargetType.RECORD, source.record.id,
                          LifecycleOperation.PURGE, None)

    assert [(blocker.entity_type, blocker.entity_id) for blocker in plan.blockers] == [
        ("board_record_links", link.id)
    ]
    # The record card itself is listed for removal, never a blocker.
    assert ("board_cards", rows["record_card"].id) in {
        (row.entity_type, row.entity_id) for row in plan.rows
    }


@pytest.mark.parametrize(
    "target",
    [LifecycleTargetType.RECORD, LifecycleTargetType.MODULE, LifecycleTargetType.DEPARTMENT],
)
def test_source_purges_list_and_remove_record_cards_without_blocking(
    integration_owner_db: Session, target: LifecycleTargetType
) -> None:
    db = integration_owner_db
    create_document(db, organization(db))
    source = record_source(db)
    elsewhere = project_board(db)
    rows = _kanban(db, elsewhere, source)
    own_board = department_board(db, source.department)
    own = _kanban(db, own_board, source)
    timestamp = datetime.now(UTC)
    closed: dict[LifecycleTargetType, list[Any]] = {
        LifecycleTargetType.RECORD: [source.record],
        LifecycleTargetType.MODULE: [source.record, source.module],
        LifecycleTargetType.DEPARTMENT: [source.record, source.module, source.department],
    }
    for row in closed[target]:
        row.is_deleted, row.deleted_at = True, timestamp
    db.commit()
    target_id: Callable[[], Any] = {
        LifecycleTargetType.RECORD: lambda: source.record.id,
        LifecycleTargetType.MODULE: lambda: source.module.id,
        LifecycleTargetType.DEPARTMENT: lambda: source.department.id,
    }[target]
    plan = plan_lifecycle(db, target, target_id(), LifecycleOperation.PURGE, None)
    assert not plan.blockers
    record_card = rows["record_card"]
    listed = {(row.entity_type, row.entity_id) for row in plan.rows}
    assert ("board_cards", record_card.id) in listed
    assert ("board_cards", rows["objective"].id) not in listed
    execute_lifecycle(db, plan)
    db.expire_all()

    assert db.get(BoardCard, record_card.id) is None
    remaining = db.scalars(select(BoardCard.title).where(BoardCard.board_id == elsewhere.id))
    assert remaining.all() == ["Plan"]
    assert _count(db, BoardCardLabel, elsewhere.id) == 1
    assert _count(db, BoardCardChecklistItem, elsewhere.id) == 1
    assert db.get(Board, elsewhere.id) is not None
    if target is LifecycleTargetType.DEPARTMENT:
        # The Department's own Board goes with its whole Kanban.
        assert db.get(Board, own_board.id) is None
        assert [_count(db, model, own_board.id) for model in KANBAN] == [0, 0, 0, 0, 0]
    else:
        assert _count(db, BoardCard, own_board.id) == 1
        assert db.get(BoardStage, own["stage"].id) is not None


def _store(db: Session, row: object) -> None:
    with db.begin_nested():
        db.add(row)
        db.flush()


@pytest.mark.parametrize(
    ("case", "constraint"),
    [
        ("objective_with_record", "ck_board_cards_kind_columns"),
        ("record_with_title", "ck_board_cards_kind_columns"),
        ("dates_reversed", "ck_board_cards_dates"),
        ("second_active_record_card", "uq_board_cards_board_record_active"),
        ("duplicate_active_rank", "uq_board_cards_stage_rank_active"),
        ("stage_color", "ck_board_stages_color"),
        ("stage_wip_zero", "ck_board_stages_wip_limit"),
        ("duplicate_active_stage_position", "uq_board_stages_board_position_active"),
        ("label_name_case", "uq_board_labels_board_name"),
        ("label_from_other_board", "fk_board_card_labels_label_id_board_labels"),
        ("link_with_two_owners", "ck_board_record_links_one_owner"),
    ],
)
def test_kanban_storage_rejects_invalid_rows(
    integration_owner_db: Session, case: str, constraint: str
) -> None:
    db = integration_owner_db
    board, other = project_board(db), project_board(db)
    source = record_source(db)
    rows = _kanban(db, board, source)
    stage, card = rows["stage"], rows["objective"]
    base = {"org_id": board.org_id, "board_id": board.id, "stage_id": stage.id}
    other_label = BoardLabel(org_id=other.org_id, board_id=other.id, name="Theirs",
                             color="chart-2", position=0)
    _store(db, other_label)
    add_stage(db, board, "Archived", 1, archived_at=datetime.now(UTC))
    event = BoardEvent(org_id=board.org_id, board_id=board.id, author_id=member(db).id,
                       title="Review", all_day=True, start_date=date(2026, 11, 2),
                       end_date=date(2026, 11, 2), timezone_name="UTC")
    _store(db, event)
    _store(db, BoardStage(org_id=board.org_id, board_id=board.id, name="Same place",
                          position=1, archived_at=datetime.now(UTC)))
    invalid = {
        "objective_with_record": BoardCard(**base, kind="objective", title="x", rank=9,
                                           record_id=source.record.id,
                                           module_id=source.module.id),
        "record_with_title": BoardCard(**base, kind="record", title="x", rank=9,
                                       record_id=source.record.id, module_id=source.module.id),
        "dates_reversed": BoardCard(**base, kind="objective", title="x", rank=9,
                                    start_on=date(2026, 11, 2), due_on=date(2026, 11, 1)),
        "second_active_record_card": BoardCard(**base, kind="record", rank=9,
                                               record_id=source.record.id,
                                               module_id=source.module.id),
        "duplicate_active_rank": BoardCard(**base, kind="objective", title="x", rank=1024),
        "stage_color": BoardStage(org_id=board.org_id, board_id=board.id, name="x",
                                  position=5, color="red"),
        "stage_wip_zero": BoardStage(org_id=board.org_id, board_id=board.id, name="x",
                                     position=5, wip_limit=0),
        "duplicate_active_stage_position": BoardStage(org_id=board.org_id, board_id=board.id,
                                                      name="x", position=0),
        "label_name_case": BoardLabel(org_id=board.org_id, board_id=board.id, name="URGENT",
                                      color="chart-1", position=1),
        "label_from_other_board": BoardCardLabel(org_id=board.org_id, board_id=board.id,
                                                 card_id=card.id, label_id=other_label.id),
        "link_with_two_owners": BoardRecordLink(
            org_id=board.org_id, board_id=board.id, card_id=card.id, event_id=event.id,
            record_id=source.record.id, module_id=source.module.id,
        ),
    }[case]
    with pytest.raises(IntegrityError) as raised:
        _store(db, invalid)
    assert constraint in str(raised.value.orig)
