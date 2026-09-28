"""A Sandbox publish gives every department its Board and keeps it in step."""

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.boards.models import Board, BoardScope
from app.systems.sandbox.departments.models import Department
from tests.sandbox_publications.support import (
    binding,
    publish_revision,
    publish_structure,
    publishable_document,
)

pytestmark = pytest.mark.integration


def _department_boards(db: Session) -> dict[object, Board]:
    return {
        board.department_id: board
        for board in db.scalars(
            select(Board).where(
                Board.scope == BoardScope.DEPARTMENT.value, Board.is_deleted.is_(False)
            )
        )
    }


def test_a_published_department_gets_its_board(integration_owner_db: Session) -> None:
    db = integration_owner_db
    publisher, document = publish_structure(db, publishable_document())

    boards = _department_boards(db)
    for department_document in document.design.departments:
        department = db.get(
            Department, binding(db, "department", department_document.id).department_id
        )
        assert department is not None
        board = boards[department.id]
        assert board.name == department_document.name
        assert board.status == "active"

    renamed = document.model_copy(deep=True)
    commercial = next(item for item in renamed.design.departments if item.id == "sample-commercial")
    commercial.name = "Sales"
    commercial.closed = True
    for module in renamed.design.modules:
        if module.department_id == "sample-commercial":
            module.closed = True
            for field in module.fields:
                field.closed = True
    for relationship in list(renamed.design.relationships):
        renamed.design.relationships.remove(relationship)
    publish_revision(db, publisher, renamed, "close-commercial")

    department_id = binding(db, "department", "sample-commercial").department_id
    board = _department_boards(db)[department_id]
    db.refresh(board)
    assert board.name == "Sales"
    assert board.status == "archived"
    assert len([item for item in _department_boards(db) if item == department_id]) == 1
