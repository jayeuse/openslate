"""Board schema constraints on the runner-owned disposable PostgreSQL database."""

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.systems.access.users.models import Role, User
from app.systems.boards.models import Board, BoardGrant, BoardRecordPlacement
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record

pytestmark = pytest.mark.integration


def test_board_grants_enforce_references_and_active_uniqueness(integration_owner_db) -> None:
    db = integration_owner_db
    member_role = db.scalar(select(Role).where(Role.role == "member"))
    assert member_role is not None
    owner_id = uuid7()
    owner = User(
        id=owner_id,
        email=f"board-{owner_id}@example.test",
        username=f"board_{owner_id.hex[:12]}",
        status="active",
        role_id=member_role.id,
    )
    department = Department(department_name=f"Board department {uuid7()}")
    db.add_all([owner, department])
    db.flush()

    board = Board(
        owner_id=owner.id,
        department_id=department.id,
        name="Operations",
    )
    db.add(board)
    db.flush()
    assert board.status == "active"
    assert board.default_section == "overview"
    assert board.revision == 1

    decision = BoardGrant(
        board_id=board.id,
        principal_type="everyone",
        permission="view",
        effect="allow",
    )
    db.add(decision)
    db.flush()
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(
                BoardGrant(
                    board_id=board.id,
                    principal_type="everyone",
                    permission="view",
                    effect="allow",
                )
            )
            db.flush()

    decision.is_deleted = True
    db.flush()
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="everyone",
            permission="view",
            effect="allow",
        )
    )
    db.flush()

    for bad_grant in (
        BoardGrant(
            board_id=board.id,
            principal_type="user",
            permission="view",
            effect="allow",
        ),
        BoardGrant(
            board_id=board.id,
            principal_type="everyone",
            principal_user_id=owner.id,
            permission="view",
            effect="deny",
        ),
    ):
        with pytest.raises(IntegrityError):
            with db.begin_nested():
                db.add(bad_grant)
                db.flush()

    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(Board(owner_id=owner.id, department_id=uuid7(), name="Wrong department"))
            db.flush()


def test_board_record_placements_enforce_unique_restrictive_links(integration_owner_db) -> None:
    db = integration_owner_db
    member_role = db.scalar(select(Role).where(Role.role == "member"))
    assert member_role is not None
    owner_id = uuid7()
    owner = User(
        id=owner_id,
        email=f"placement-{owner_id}@example.test",
        username=f"placement_{owner_id.hex[:12]}",
        status="active",
        role_id=member_role.id,
    )
    department = Department(department_name=f"Placement department {uuid7()}")
    db.add_all([owner, department])
    db.flush()
    board = Board(owner_id=owner.id, department_id=department.id, name="Record shortcuts")
    module = Module(department_id=department.id, module_name="Placement records")
    db.add_all([board, module])
    db.flush()
    record = Record(module_id=module.id, data={})
    db.add(record)
    db.flush()

    placement = BoardRecordPlacement(board_id=board.id, record_id=record.id)
    db.add(placement)
    db.flush()
    assert placement.id is not None

    for invalid in (
        BoardRecordPlacement(board_id=board.id, record_id=record.id),
        BoardRecordPlacement(board_id=uuid7(), record_id=record.id),
        BoardRecordPlacement(board_id=board.id, record_id=uuid7()),
    ):
        with pytest.raises(IntegrityError):
            with db.begin_nested():
                db.add(invalid)
                db.flush()

    record.is_deleted = True
    board.status = "archived"
    db.flush()
    assert db.get(BoardRecordPlacement, placement.id) is placement
