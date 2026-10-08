"""Only project Boards are purged on their own; a department always keeps its Board.

A department Board is deleted only by the department purge (see
``test_lifecycle.py``), and the company Board is never deleted.
"""

from collections.abc import Callable

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.boards import lifecycle_router
from app.systems.boards.models import Board, BoardScope, BoardStatus
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.challenge_store import issue_challenge
from app.systems.sandbox.lifecycle.execution import execute_lifecycle
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleTargetType
from tests.boards.support import admin, client, company_board, department_board
from tests.boards.test_permanent_delete import _enabled

pytestmark = pytest.mark.integration


def _archived_department_board(db: Session) -> Board:
    board = department_board(db)
    board.status = BoardStatus.ARCHIVED
    db.flush()
    return board


@pytest.mark.parametrize("fixed_board", [company_board, _archived_department_board])
def test_company_and_department_boards_cannot_be_purged_on_their_own(
    integration_owner_db: Session,
    monkeypatch: pytest.MonkeyPatch,
    fixed_board: Callable[[Session], Board],
) -> None:
    db = integration_owner_db
    actor = admin(db)
    board = fixed_board(db)
    db.commit()
    _enabled(monkeypatch, True)
    api = client(db, actor, lifecycle_router.router)
    path = f"/api/boards/{board.id}/purge"

    preview = api.post(f"{path}/preview")
    assert preview.status_code == 409
    assert preview.json()["detail"]["code"] == "board_scope_fixed"

    token = issue_challenge(db, actor.id, "purge", "board", board.id, "impact").token
    purge = api.post(
        path,
        json={"token": token, "confirmation_name": board.name, "password": uuid7().hex},
    )
    assert purge.status_code == 409
    assert purge.json()["detail"]["code"] == "board_scope_fixed"
    assert db.get(Board, board.id) is not None


def test_reopening_a_department_restores_a_missing_board(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    actor = admin(db)
    department = Department(department_name=f"Reopen {uuid7().hex[:8]}")
    db.add(department)
    db.flush()
    department_board(db, department)
    db.commit()
    close = plan_lifecycle(db, LifecycleTargetType.DEPARTMENT, department.id, "close", actor.id)
    execute_lifecycle(db, close)
    # A Board lost while the department was closed, as the old standalone purge allowed.
    lost = db.scalar(select(Board).where(Board.department_id == department.id))
    assert lost is not None
    db.delete(lost)
    db.commit()

    reopen = plan_lifecycle(db, LifecycleTargetType.DEPARTMENT, department.id, "reopen", actor.id)
    execute_lifecycle(db, reopen)

    boards = db.scalars(
        select(Board).where(Board.department_id == department.id, Board.is_deleted.is_(False))
    ).all()
    assert [(item.scope, item.status) for item in boards] == [
        (BoardScope.DEPARTMENT.value, BoardStatus.ACTIVE)
    ]
