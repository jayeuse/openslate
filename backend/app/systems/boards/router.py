"""Board metadata and lifecycle API."""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user, require_admin
from app.common.listing import (
    ListQuerySpec,
    execute_standard_list,
)
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.scope import includes
from app.systems.access.users.membership import sole_active_membership
from app.systems.access.users.models import User
from app.systems.boards.access import board_level, visible_board_clause
from app.systems.boards.models import Board, BoardScope, BoardStatus
from app.systems.boards.schemas import (
    BoardCreate,
    BoardListRequest,
    BoardListResponse,
    BoardResponse,
    BoardRevisionRequest,
    BoardSort,
    BoardStatusFilter,
    BoardUpdate,
)


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(get_current_user)]
Admin = Annotated[User, Depends(require_admin)]
Database = Annotated[Session, Depends(get_db)]

BOARD_LIST_SPEC = ListQuerySpec(
    sort_fields={
        BoardSort.NAME: cast(ColumnElement[Any], Board.name),
        BoardSort.CREATED_AT: cast(ColumnElement[Any], Board.created_at),
        BoardSort.UPDATED_AT: cast(ColumnElement[Any], Board.updated_at),
    },
    default_sort=BoardSort.NAME,
    tie_breaker=cast(ColumnElement[Any], Board.id),
    search_fields=(cast(ColumnElement[str], Board.name),),
    deleted_field=None,
)


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Board not found")


def _forbidden() -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


def _conflict(code: str, message: str, **extra: int) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"code": code, "message": message, **extra},
    )


def _stale_revision(current_revision: int) -> HTTPException:
    return _conflict(
        "stale_revision",
        "Board changed; reload before saving",
        current_revision=current_revision,
    )


def _board_with_access(
    db: Session,
    actor: User,
    board_id: UUID,
    level: AccessLevel,
    *,
    lock: bool = False,
) -> Board:
    """Load a live Board: 404 when the actor cannot read it, 403 below ``level``."""

    statement = select(Board).where(
        Board.id == board_id,
        Board.is_deleted.is_(False),
        Board.deleted_at.is_(None),
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    board = db.scalar(statement)
    if board is None:
        raise _not_found()
    granted = board_level(db, actor, board)
    if granted is None:
        raise _not_found()
    if not includes(granted, level):
        raise _forbidden()
    return board


def _commit(db: Session, code: str, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict(code, message) from error


def _response(db: Session, actor: User, board: Board) -> BoardResponse:
    level = board_level(db, actor, board)
    if level is None:
        raise _not_found()
    return BoardResponse.model_validate(
        {
            "id": board.id,
            "scope": board.scope,
            "department_id": board.department_id,
            "name": board.name,
            "description": board.description,
            "status": board.status,
            "revision": board.revision,
            "level": level,
            "created_at": board.created_at,
            "updated_at": board.updated_at,
        }
    )


@router.get("", response_model=BoardListResponse)
def list_boards(
    user: Reader,
    db: Database,
    params: Annotated[BoardListRequest, Query()],
) -> BoardListResponse:
    statement = select(Board).where(
        Board.is_deleted.is_(False),
        Board.deleted_at.is_(None),
        visible_board_clause(db, user),
    )
    if params.status is not BoardStatusFilter.ALL:
        statement = statement.where(Board.status == params.status.value)
    if params.scope is not None:
        statement = statement.where(Board.scope == params.scope.value)
    if params.department_id is not None:
        statement = statement.where(Board.department_id == params.department_id)

    result = execute_standard_list(db, statement, params, BOARD_LIST_SPEC)
    return BoardListResponse(
        items=[_response(db, user, board) for board in result.items],
        pagination=result.pagination,
    )


@router.post("", response_model=BoardResponse, status_code=status.HTTP_201_CREATED)
def create_board(
    payload: BoardCreate,
    user: Admin,
    db: Database,
    response: Response,
) -> BoardResponse:
    """Administrators create project Boards; company and department Boards are fixed."""

    board = Board(
        org_id=sole_active_membership(db, user.id).org_id,
        scope=BoardScope.PROJECT.value,
        name=payload.name,
        description=payload.description,
        status=BoardStatus.ACTIVE,
    )
    db.add(board)
    _commit(db, "board_invalid", "Unable to create Board")
    db.refresh(board)
    response.headers["Location"] = f"/api/boards/{board.id}"
    return _response(db, user, board)


@router.get("/{board_id}", response_model=BoardResponse)
def read_board(board_id: UUID, user: Reader, db: Database) -> BoardResponse:
    return _response(db, user, _board_with_access(db, user, board_id, AccessLevel.READ))


@router.patch("/{board_id}", response_model=BoardResponse)
def update_board(
    board_id: UUID,
    payload: BoardUpdate,
    user: Reader,
    db: Database,
) -> BoardResponse:
    board = _board_with_access(db, user, board_id, AccessLevel.MANAGE, lock=True)
    if board.revision != payload.revision:
        raise _stale_revision(board.revision)
    if board.status == BoardStatus.ARCHIVED:
        raise _conflict("board_archived", "Restore the Board before editing it")

    changes = payload.model_fields_set - {"revision"}
    if "name" in changes and board.scope == BoardScope.DEPARTMENT.value:
        raise _conflict(
            "board_name_fixed", "A department Board has the name of its department"
        )
    name = payload.name if payload.name is not None else board.name
    description = payload.description if "description" in changes else board.description
    if name == board.name and description == board.description:
        return _response(db, user, board)

    board.name = name
    board.description = description
    board.revision += 1
    _commit(db, "board_invalid", "Unable to update Board")
    db.refresh(board)
    return _response(db, user, board)


def _project_board(board: Board) -> None:
    if board.scope != BoardScope.PROJECT.value:
        raise _conflict(
            "board_scope_fixed",
            "Company and department Boards follow the workspace and their department",
        )


@router.post("/{board_id}/archive", response_model=BoardResponse)
def archive_board(
    board_id: UUID,
    payload: BoardRevisionRequest,
    user: Reader,
    db: Database,
) -> BoardResponse:
    board = _board_with_access(db, user, board_id, AccessLevel.MANAGE, lock=True)
    _project_board(board)
    if board.revision != payload.revision:
        raise _stale_revision(board.revision)
    if board.status == BoardStatus.ARCHIVED:
        raise _conflict("board_archived", "The Board is already archived")
    board.status = BoardStatus.ARCHIVED
    board.revision += 1
    _commit(db, "board_invalid", "Unable to archive Board")
    db.refresh(board)
    return _response(db, user, board)


@router.post("/{board_id}/restore", response_model=BoardResponse)
def restore_board(
    board_id: UUID,
    payload: BoardRevisionRequest,
    user: Reader,
    db: Database,
) -> BoardResponse:
    board = _board_with_access(db, user, board_id, AccessLevel.MANAGE, lock=True)
    _project_board(board)
    if board.revision != payload.revision:
        raise _stale_revision(board.revision)
    if board.status != BoardStatus.ARCHIVED:
        raise _conflict("board_not_archived", "The Board is not archived")
    board.status = BoardStatus.ACTIVE
    board.revision += 1
    _commit(db, "board_invalid", "Unable to restore Board")
    db.refresh(board)
    return _response(db, user, board)
