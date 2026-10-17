"""Each department has one Board that follows the department's name and state."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.boards.models import Board, BoardScope, BoardStatus
from app.systems.sandbox.departments.models import Department

COMPANY_BOARD_NAME = "Company"


def sync_department_board(
    db: Session, department: Department, *, actor_id: UUID | None = None, create: bool = True
) -> Board | None:
    """Create the department's Board, or align its name and status with the department.

    A closed department archives its Board and a reopened one restores it. With
    ``create`` false, a department without a Board is left alone. The caller owns
    the transaction.
    """

    board = db.scalar(
        select(Board)
        .where(
            Board.scope == BoardScope.DEPARTMENT.value,
            Board.department_id == department.id,
            Board.is_deleted.is_(False),
        )
        .with_for_update()
    )
    status = BoardStatus.ARCHIVED if department.is_deleted else BoardStatus.ACTIVE
    name = department.department_name[:200]
    if board is None:
        if not create:
            return None
        board = Board(
            org_id=department.org_id,
            scope=BoardScope.DEPARTMENT.value,
            department_id=department.id,
            name=name,
            status=status,
            performed_by=actor_id,
        )
        db.add(board)
        db.flush()
        return board
    if board.name != name or board.status != status:
        board.name = name
        board.status = status
        board.revision += 1
        if actor_id is not None:
            board.performed_by = actor_id
        db.flush()
    return board
