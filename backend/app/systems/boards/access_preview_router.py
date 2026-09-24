"""Read-only Board-level effective access preview."""

from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel
from sqlalchemy import Select, select
from sqlalchemy.orm import Session, joinedload
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_capability
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database import get_db
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.access.users.permissions import Capability
from app.systems.boards.access import can_access_board, can_read_board_grants
from app.systems.boards.models import Board, BoardGrant, BoardPermission

router = APIRouter(prefix="/boards", tags=["boards"])
Reader = Annotated[User, Depends(require_capability(Capability.RECORDS_READ))]
Database = Annotated[Session, Depends(get_db)]


class BoardAccessPreview(BaseModel):
    view: bool
    edit: bool
    manage: bool


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


def _manager_board(db: Session, manager: User, board_id: UUID) -> tuple[Board, list[BoardGrant]]:
    board = db.scalar(
        select(Board).where(
            Board.id == board_id,
            Board.is_deleted.is_(False),
            Board.deleted_at.is_(None),
        )
    )
    if board is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Board not found")
    grants = list(
        db.scalars(
            select(BoardGrant).where(
                BoardGrant.board_id == board_id,
                BoardGrant.is_deleted.is_(False),
                BoardGrant.deleted_at.is_(None),
            )
        ).all()
    )
    if not can_read_board_grants(board, manager, grants):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Board not found")
    return board, grants


def _eligible_users() -> Select[tuple[User]]:
    return (
        select(User)
        .join(Role, User.role_id == Role.id)
        .where(
            User.status == UserStatus.ACTIVE.value,
            User.is_deleted.is_(False),
            User.deleted_at.is_(None),
            established_user_clause(),
            Role.is_deleted.is_(False),
            Role.deleted_at.is_(None),
        )
    )


@router.get("/{board_id}/my-access", response_model=BoardAccessPreview)
def my_board_access(
    board_id: UUID,
    actor: Reader,
    db: Database,
    response: Response,
) -> BoardAccessPreview:
    """Return only the authenticated actor's effective Board permissions."""

    board = db.scalar(
        select(Board).where(
            Board.id == board_id,
            Board.is_deleted.is_(False),
            Board.deleted_at.is_(None),
        )
    )
    if board is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Board not found")
    grants = list(
        db.scalars(
            select(BoardGrant).where(
                BoardGrant.board_id == board_id,
                BoardGrant.is_deleted.is_(False),
                BoardGrant.deleted_at.is_(None),
            )
        ).all()
    )
    if not can_access_board(board, actor, BoardPermission.VIEW, grants):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Board not found")
    response.headers["Cache-Control"] = "private, no-store"
    return BoardAccessPreview(
        view=True,
        edit=can_access_board(board, actor, BoardPermission.EDIT, grants),
        manage=can_access_board(board, actor, BoardPermission.MANAGE, grants),
    )


@router.get("/{board_id}/access-preview", response_model=BoardAccessPreview)
def preview_board_access(
    board_id: UUID,
    user_id: Annotated[UUID, Query()],
    manager: Reader,
    db: Database,
    response: Response,
) -> BoardAccessPreview:
    """Preview effective Board ACL and global gates, never content audiences."""

    board, grants = _manager_board(db, manager, board_id)
    target = db.scalar(_eligible_users().options(joinedload(User.role)).where(User.id == user_id))
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Preview user not found")
    response.headers["Cache-Control"] = "no-store"
    return BoardAccessPreview(
        view=can_access_board(board, target, BoardPermission.VIEW, grants),
        edit=can_access_board(board, target, BoardPermission.EDIT, grants),
        manage=can_access_board(board, target, BoardPermission.MANAGE, grants),
    )


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
