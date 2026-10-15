"""Shared builders for Board tests: scoped Boards and the groups that reach them."""

from __future__ import annotations

from collections.abc import Iterable

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel, Group, GroupMember
from app.systems.access.users.models import User, UserRole
from app.systems.boards.department_boards import sync_department_board
from app.systems.boards.models import Board, BoardGroup, BoardScope
from app.systems.sandbox.departments.models import Department
from tests.rbac.support import add_department, add_user, make_group_access, organization


def client(db: Session, actor: User | None, *routers: APIRouter) -> TestClient:
    """The given routers alone, on *db*, as *actor*; ``None`` keeps the real auth (401)."""

    app = FastAPI()
    for router in routers:
        app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    if actor is not None:
        app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def admin(db: Session, name: str = "board-admin") -> User:
    return add_user(db, name, role=UserRole.ADMIN)


def member(db: Session, name: str = "board-member") -> User:
    return add_user(db, name, role=UserRole.MEMBER)


def guest(db: Session, name: str = "board-guest") -> User:
    return add_user(db, name, role=UserRole.GUEST)


def company_board(db: Session) -> Board:
    """Create this test organization's company Board, formerly seeded by the root."""

    board = db.scalar(
        select(Board).where(Board.scope == BoardScope.COMPANY.value,
                            Board.org_id == organization(db).id, Board.is_deleted.is_(False))
    )
    if board is None:
        board = Board(org_id=organization(db).id, scope=BoardScope.COMPANY.value,
                      name="Company")
        db.add(board)
        db.flush()
    return board


def department_board(db: Session, department: Department | None = None) -> Board:
    """The Board of a department, created the way a Sandbox publish creates it."""

    target = department or add_department(db)
    board = sync_department_board(db, target)
    assert board is not None
    return board


def project_board(db: Session, name: str | None = None, *, description: str | None = None) -> Board:
    board = Board(
        org_id=organization(db).id,
        scope=BoardScope.PROJECT.value,
        name=name or f"Project {uuid7().hex[:8]}",
        description=description,
    )
    db.add(board)
    db.flush()
    return board


def board_group(
    db: Session,
    board: Board,
    members: Iterable[User],
    level: str = AccessLevel.READ,
    *,
    group: Group | None = None,
) -> BoardGroup:
    """Give a new or existing group ``level`` on a project Board."""

    if group is None:
        group = Group(org_id=board.org_id, name=f"Board group {uuid7().hex}")
        db.add(group)
        db.flush()
    for user in members:
        db.add(GroupMember(org_id=board.org_id, group_id=group.id, user_id=user.id))
    row = BoardGroup(org_id=board.org_id, board_id=board.id, group_id=group.id, level=str(level))
    db.add(row)
    db.flush()
    return row


def grant(db: Session, board: Board, users: Iterable[User], level: str = AccessLevel.READ) -> None:
    """Give users ``level`` on a Board through the rule its scope uses."""

    people = list(users)
    if board.scope == BoardScope.PROJECT.value:
        board_group(db, board, people, level)
        return
    assert board.scope == BoardScope.DEPARTMENT.value and board.department_id is not None
    department = db.get(Department, board.department_id)
    assert department is not None
    make_group_access(db, people, department, level=level)


def writable_board(db: Session, *writers: User, level: str = AccessLevel.WRITE) -> Board:
    """A project Board that the given users can write on."""

    board = project_board(db)
    if writers:
        grant(db, board, writers, level)
    return board
