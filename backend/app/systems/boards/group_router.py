"""The groups that read, write or manage a project Board."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user, require_admin
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel, Group
from app.systems.access.users.models import User
from app.systems.boards.models import Board, BoardGroup, BoardScope
from app.systems.boards.router import _board_with_access, _conflict, _stale_revision
from app.systems.boards.schemas import (
    BoardGroupResponse,
    BoardGroupsReplace,
    BoardGroupsResponse,
)


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(get_current_user)]
Admin = Annotated[User, Depends(require_admin)]
Database = Annotated[Session, Depends(get_db)]


def _project(board: Board) -> None:
    if board.scope != BoardScope.PROJECT.value:
        raise _conflict(
            "board_scope_fixed",
            "Only project Boards have groups; company and department Boards follow Access",
        )


def _rows(db: Session, board_id: UUID, *, lock: bool = False) -> list[BoardGroup]:
    statement = (
        select(BoardGroup)
        .where(BoardGroup.board_id == board_id, BoardGroup.is_deleted.is_(False))
        .order_by(BoardGroup.id)
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    return list(db.scalars(statement).all())


def _response(db: Session, board: Board) -> BoardGroupsResponse:
    rows = db.execute(
        select(BoardGroup.group_id, Group.name, BoardGroup.level)
        .join(Group, Group.id == BoardGroup.group_id)
        .where(
            BoardGroup.board_id == board.id,
            BoardGroup.is_deleted.is_(False),
            Group.is_deleted.is_(False),
        )
        .order_by(Group.name, Group.id)
    ).all()
    return BoardGroupsResponse(
        board_id=board.id,
        revision=board.revision,
        groups=[
            BoardGroupResponse(group_id=group_id, name=name, level=AccessLevel(level))
            for group_id, name, level in rows
        ],
    )


@router.get("/{board_id}/groups", response_model=BoardGroupsResponse)
def list_board_groups(board_id: UUID, actor: Reader, db: Database) -> BoardGroupsResponse:
    board = _board_with_access(db, actor, board_id, AccessLevel.MANAGE)
    _project(board)
    return _response(db, board)


@router.put("/{board_id}/groups", response_model=BoardGroupsResponse)
def replace_board_groups(
    board_id: UUID, payload: BoardGroupsReplace, actor: Admin, db: Database
) -> BoardGroupsResponse:
    """Replace the whole set of groups and levels; administrators only."""

    board = _board_with_access(db, actor, board_id, AccessLevel.MANAGE, lock=True)
    _project(board)
    if board.revision != payload.revision:
        raise _stale_revision(board.revision)
    wanted = {entry.group_id: entry.level for entry in payload.groups}
    if wanted:
        live = set(
            db.scalars(
                select(Group.id)
                .where(Group.id.in_(sorted(wanted)), Group.is_deleted.is_(False))
                .with_for_update()
            ).all()
        )
        if live != set(wanted):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={"code": "group_unavailable", "message": "A selected group is unavailable"},
            )
    changed = False
    for row in _rows(db, board.id, lock=True):
        level = wanted.pop(row.group_id, None)
        if level is None:
            db.delete(row)
            changed = True
        elif row.level != level.value:
            row.level = level.value
            changed = True
    for group_id, level in wanted.items():
        db.add(BoardGroup(board_id=board.id, group_id=group_id, level=level.value))
        changed = True
    if changed:
        board.revision += 1
        try:
            db.commit()
        except IntegrityError as error:
            db.rollback()
            raise _conflict("board_groups_conflict", "Board groups changed; reload") from error
        db.refresh(board)
    return _response(db, board)
