"""Department lifecycle follows the department's Board, and Record purge waits for links."""

from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.boards.models import Board, BoardStatus
from app.systems.boards.post_models import BoardPost
from app.systems.boards.record_link_models import BoardRecordLink
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.exceptions import (
    LifecyclePlanDriftError,
    LifecyclePreflightError,
)
from app.systems.sandbox.lifecycle.execution import execute_lifecycle
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleBlockerCode, LifecycleTargetType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.boards.support import admin, department_board, project_board

pytestmark = pytest.mark.integration


def _closed_department(db: Session, name: str) -> Department:
    now = datetime.now(UTC)
    department = Department(
        department_name=f"{name} {uuid7().hex[:8]}", is_deleted=True, deleted_at=now
    )
    db.add(department)
    db.flush()
    return department


def test_closing_a_department_archives_its_board_and_reopening_restores_it(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    actor = admin(db)
    department = Department(department_name=f"Close {uuid7().hex[:8]}")
    db.add(department)
    db.flush()
    board = department_board(db, department)
    db.commit()

    close = plan_lifecycle(db, LifecycleTargetType.DEPARTMENT, department.id, "close", actor.id)
    execute_lifecycle(db, close)
    db.refresh(board)
    assert board.status == BoardStatus.ARCHIVED

    reopen = plan_lifecycle(db, LifecycleTargetType.DEPARTMENT, department.id, "reopen", actor.id)
    execute_lifecycle(db, reopen)
    db.refresh(board)
    assert board.status == BoardStatus.ACTIVE


def test_department_purge_removes_its_empty_board(integration_owner_db: Session) -> None:
    db = integration_owner_db
    department = _closed_department(db, "Empty board")
    board = department_board(db, department)
    other = project_board(db)
    db.commit()
    department_id, board_id = department.id, board.id

    plan = plan_lifecycle(db, LifecycleTargetType.DEPARTMENT, department_id, "purge", None)
    assert [row.entity_id for row in plan.rows if row.entity_type == "boards"] == [board_id]
    assert not plan.blockers
    execute_lifecycle(db, plan)

    assert db.get(Department, department_id) is None
    assert db.get(Board, board_id) is None
    assert db.get(Board, other.id) is not None


def test_department_purge_waits_for_the_board_purge_when_the_board_has_content(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = admin(db)
    department = _closed_department(db, "Board with posts")
    board = department_board(db, department)
    db.add(BoardPost(board_id=board.id, author_id=author.id, title="Kept", body="Body"))
    db.commit()

    plan = plan_lifecycle(db, LifecycleTargetType.DEPARTMENT, department.id, "purge", None)
    [blocker] = [
        item for item in plan.blockers if item.code is LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY
    ]
    assert blocker.entity_type == "boards"
    assert blocker.entity_id == board.id
    assert blocker.department_id == department.id
    assert "board" in blocker.detail.casefold()
    with pytest.raises(LifecyclePreflightError):
        execute_lifecycle(db, plan)
    assert db.get(Department, department.id) is not None
    assert db.get(Board, board.id) is not None


def test_department_purge_plan_drifts_when_its_board_changes_before_execution(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    department = _closed_department(db, "Drift")
    board = department_board(db, department)
    db.commit()

    plan = plan_lifecycle(db, LifecycleTargetType.DEPARTMENT, department.id, "purge", None)
    before = next(row for row in plan.rows if row.entity_type == "boards")
    board.description = "Changed after preview"
    board.revision += 1
    db.commit()
    current = plan_lifecycle(db, LifecycleTargetType.DEPARTMENT, department.id, "purge", None)
    after = next(row for row in current.rows if row.entity_type == "boards")
    assert after.state_fingerprint != before.state_fingerprint
    with pytest.raises(LifecyclePlanDriftError):
        execute_lifecycle(db, plan)
    assert db.get(Board, board.id) is not None


@pytest.mark.parametrize("target_type", ["module", "department"])
def test_parent_purge_waits_for_board_record_links_to_be_removed(
    integration_owner_db: Session, target_type: str
) -> None:
    db = integration_owner_db
    now = datetime.now(UTC)
    author = admin(db)
    department = _closed_department(db, "Linked parent")
    department_board(db, department)
    module = Module(
        department_id=department.id, module_name="Linked", is_deleted=True, deleted_at=now
    )
    db.add(module)
    db.flush()
    record = Record(module_id=module.id, data={}, is_deleted=True, deleted_at=now)
    board = project_board(db)
    db.add(record)
    db.flush()
    item = BoardPost(board_id=board.id, author_id=author.id, title="Linked", body="Body")
    db.add(item)
    db.flush()
    link = BoardRecordLink(
        board_id=board.id, post_id=item.id, record_id=record.id, module_id=module.id, label="Item"
    )
    db.add(link)
    db.commit()
    target_id = module.id if target_type == "module" else department.id

    plan = plan_lifecycle(db, target_type, target_id, "purge", author.id)
    assert link.id in {
        blocker.entity_id
        for blocker in plan.blockers
        if blocker.code is LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY
    }
    with pytest.raises(LifecyclePreflightError):
        execute_lifecycle(db, plan)
    assert db.get(Record, record.id) is not None

    db.delete(link)
    db.commit()
    unlinked = plan_lifecycle(db, target_type, target_id, "purge", author.id)
    assert not unlinked.blockers
    execute_lifecycle(db, unlinked)
    assert db.get(Record, record.id) is None
    assert db.get(Module, module.id) is None
