"""The effective level of a user on a Board, for the reader and for its managers."""

from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel
from sqlalchemy import Select, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database import get_db
from app.systems.access.identity.eligibility import identity_eligible_clause
from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.scope import includes
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.models import User, UserStatus
from app.systems.boards.access import board_level
from app.systems.boards.models import Board
from app.systems.boards.router import _board_with_access

router = APIRouter(prefix="/boards", tags=["boards"])
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


class BoardAccessPreview(BaseModel):
    """``level`` is None when the user cannot read the Board."""

    level: AccessLevel | None
    read: bool
    write: bool
    manage: bool


def _preview(level: AccessLevel | None) -> BoardAccessPreview:
    return BoardAccessPreview(
        level=level,
        read=includes(level, AccessLevel.READ),
        write=includes(level, AccessLevel.WRITE),
        manage=includes(level, AccessLevel.MANAGE),
    )


class PreviewUser(BaseModel):
    id: UUID
    username: str


class PreviewUserList(StandardListResponse[PreviewUser]):
    pass


class PreviewUserSort(StrEnum):
    USERNAME = "username"


class PreviewUserListRequest(StandardListRequest[PreviewUserSort]):
    pass


PREVIEW_USER_LIST_SPEC = ListQuerySpec(
    sort_fields={PreviewUserSort.USERNAME: cast(ColumnElement[Any], User.username)},
    default_sort=PreviewUserSort.USERNAME,
    tie_breaker=cast(ColumnElement[Any], User.id),
    search_fields=(cast(ColumnElement[str], User.username),),
    deleted_field=None,
)


def _manager_board(db: Session, manager: User, board_id: UUID) -> Board:
    return _board_with_access(db, manager, board_id, AccessLevel.MANAGE)


def _eligible_users() -> Select[tuple[User]]:
    return (
        select(User)
        .where(
            User.status == UserStatus.ACTIVE.value,
            User.is_deleted.is_(False),
            User.deleted_at.is_(None),
            identity_eligible_clause(),
            established_user_clause(),
        )
    )


@router.get("/{board_id}/my-access", response_model=BoardAccessPreview)
def my_board_access(
    board_id: UUID,
    actor: Reader,
    db: Database,
    response: Response,
) -> BoardAccessPreview:
    """Return only the authenticated actor's level on the Board."""

    board = db.scalar(
        select(Board).where(
            Board.id == board_id,
            Board.is_deleted.is_(False),
            Board.deleted_at.is_(None),
        )
    )
    level = board_level(db, actor, board) if board is not None else None
    if level is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Board not found")
    response.headers["Cache-Control"] = "private, no-store"
    return _preview(level)


@router.get("/{board_id}/access-preview", response_model=BoardAccessPreview)
def preview_board_access(
    board_id: UUID,
    user_id: Annotated[UUID, Query()],
    manager: Reader,
    db: Database,
    response: Response,
) -> BoardAccessPreview:
    """Preview another user's level from the Board scope, Access groups and Board groups."""

    board = _manager_board(db, manager, board_id)
    target = db.scalar(_eligible_users().where(User.id == user_id))
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Preview user not found")
    response.headers["Cache-Control"] = "no-store"
    return _preview(board_level(db, target, board))


@router.get("/{board_id}/preview-users", response_model=PreviewUserList)
def list_preview_users(
    board_id: UUID,
    manager: Reader,
    db: Database,
    params: Annotated[PreviewUserListRequest, Query()],
    response: Response,
) -> PreviewUserList:
    """Provide only active, established chooser labels to a Board manager."""

    _manager_board(db, manager, board_id)
    result = execute_standard_list(db, _eligible_users(), params, PREVIEW_USER_LIST_SPEC)
    response.headers["Cache-Control"] = "no-store"
    return PreviewUserList(
        items=[PreviewUser(id=user.id, username=user.username) for user in result.items],
        pagination=result.pagination,
    )
