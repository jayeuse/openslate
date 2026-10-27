"""The effective level of a user on a Board, for the reader and for its managers.

It also lists the people who can read a Board, for the card assignee picker of its
writers. A card accepts an assignee who can read the Board (``valid_assignee``), so
the list uses the same rule in SQL (``board_reader_statement``).
"""

from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel
from sqlalchemy import Select, func, select
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
from app.systems.access.users.membership import bound_membership_join
from app.systems.access.users.models import Membership, User, UserStatus
from app.systems.boards.access import board_level, board_reader_statement
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


class BoardPerson(BaseModel):
    """Only person card fields that every member, guests included, sees."""

    id: UUID
    display_name: str
    avatar_url: str | None


class BoardPersonList(StandardListResponse[BoardPerson]):
    pass


class BoardPersonSort(StrEnum):
    DISPLAY_NAME = "display_name"


class BoardPersonListRequest(StandardListRequest[BoardPersonSort]):
    pass


_DISPLAY_NAME = func.coalesce(func.nullif(User.display_name, ""), User.username)
# The email is on the person card of every Board reader that a member opens; the
# username is not, so it is not searched.
BOARD_PERSON_LIST_SPEC = ListQuerySpec(
    sort_fields={BoardPersonSort.DISPLAY_NAME: cast(ColumnElement[Any], func.lower(_DISPLAY_NAME))},
    default_sort=BoardPersonSort.DISPLAY_NAME,
    tie_breaker=cast(ColumnElement[Any], User.id),
    search_fields=(cast(ColumnElement[str], _DISPLAY_NAME), cast(ColumnElement[str], User.email)),
    deleted_field=None,
)


def _manager_board(db: Session, manager: User, board_id: UUID) -> Board:
    return _board_with_access(db, manager, board_id, AccessLevel.MANAGE)


def _eligible_users() -> Select[tuple[User]]:
    return (
        select(User)
        .join(Membership, bound_membership_join())
        .where(
            User.status == UserStatus.ACTIVE.value,
            Membership.status == UserStatus.ACTIVE.value,
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


@router.get("/{board_id}/people", response_model=BoardPersonList)
def list_board_people(
    board_id: UUID,
    writer: Reader,
    db: Database,
    params: Annotated[BoardPersonListRequest, Query()],
    response: Response,
) -> BoardPersonList:
    """The active people who can read the Board now, for its writers and managers."""

    board = _board_with_access(db, writer, board_id, AccessLevel.WRITE)
    readers = board_reader_statement(select(Board.id).where(Board.id == board.id)).subquery()
    statement = select(User).join(readers, readers.c.id == User.id)
    result = execute_standard_list(db, statement, params, BOARD_PERSON_LIST_SPEC)
    response.headers["Cache-Control"] = "private, no-store"
    return BoardPersonList(
        items=[
            BoardPerson(
                id=person.id,
                display_name=person.display_name or person.username,
                avatar_url=f"/api/users/{person.id}/avatar" if person.avatar_file_id else None,
            )
            for person in result.items
        ],
        pagination=result.pagination,
    )
