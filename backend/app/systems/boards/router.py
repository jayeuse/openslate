"""Board metadata and lifecycle API."""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import and_, exists, false, not_, or_, select, true
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_legacy_capability
from app.common.listing import (
    ListQuerySpec,
    execute_standard_list,
)
from app.core.database import get_db
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.access.users.permissions import Capability
from app.systems.boards.access import can_access_board
from app.systems.boards.models import (
    Board,
    BoardGrant,
    BoardGrantEffect,
    BoardPermission,
    BoardPrincipalType,
    BoardStatus,
)
from app.systems.boards.personal_models import BoardFavorite
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
from app.systems.sandbox.departments.models import Department


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_READ))]
Writer = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_WRITE))]
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
_VIEW_ALLOW_PERMISSIONS = tuple(permission.value for permission in BoardPermission)


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Board not found")


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


def _grant_exists(
    actor: User,
    principal_type: BoardPrincipalType,
    *,
    permission_values: tuple[str, ...],
    effect: BoardGrantEffect,
) -> ColumnElement[bool]:
    conditions: list[ColumnElement[bool]] = [
        BoardGrant.board_id == Board.id,
        BoardGrant.is_deleted.is_(False),
        BoardGrant.deleted_at.is_(None),
        BoardGrant.principal_type == principal_type.value,
        BoardGrant.permission.in_(permission_values),
        BoardGrant.effect == effect.value,
    ]
    if principal_type is BoardPrincipalType.USER:
        conditions.extend(
            [
                BoardGrant.principal_user_id == actor.id,
                BoardGrant.principal_role_id.is_(None),
            ]
        )
    elif principal_type is BoardPrincipalType.ROLE:
        conditions.extend(
            [
                BoardGrant.principal_role_id == actor.role_id,
                BoardGrant.principal_user_id.is_(None),
            ]
        )
    else:
        conditions.extend(
            [BoardGrant.principal_user_id.is_(None), BoardGrant.principal_role_id.is_(None)]
        )
    return exists(select(BoardGrant.id).where(*conditions))


def _board_view_clause(actor: User) -> ColumnElement[bool]:
    """SQL equivalent of Board view precedence, applied before list pagination."""

    role = actor.role
    if (
        actor.status != UserStatus.ACTIVE.value
        or actor.is_deleted
        or actor.deleted_at is not None
        or role is None
        or role.is_deleted
        or role.deleted_at is not None
        or actor.role_id != role.id
    ):
        return false()
    if actor.role.role == UserRole.ADMIN.value:
        return true()

    user_allow = _grant_exists(
        actor,
        BoardPrincipalType.USER,
        permission_values=_VIEW_ALLOW_PERMISSIONS,
        effect=BoardGrantEffect.ALLOW,
    )
    user_deny = _grant_exists(
        actor,
        BoardPrincipalType.USER,
        permission_values=(BoardPermission.VIEW.value,),
        effect=BoardGrantEffect.DENY,
    )
    role_allow = _grant_exists(
        actor,
        BoardPrincipalType.ROLE,
        permission_values=_VIEW_ALLOW_PERMISSIONS,
        effect=BoardGrantEffect.ALLOW,
    )
    role_deny = _grant_exists(
        actor,
        BoardPrincipalType.ROLE,
        permission_values=(BoardPermission.VIEW.value,),
        effect=BoardGrantEffect.DENY,
    )
    everyone_allow = _grant_exists(
        actor,
        BoardPrincipalType.EVERYONE,
        permission_values=_VIEW_ALLOW_PERMISSIONS,
        effect=BoardGrantEffect.ALLOW,
    )
    everyone_deny = _grant_exists(
        actor,
        BoardPrincipalType.EVERYONE,
        permission_values=(BoardPermission.VIEW.value,),
        effect=BoardGrantEffect.DENY,
    )
    user_decision = or_(user_allow, user_deny)
    role_decision = or_(role_allow, role_deny)

    return or_(
        Board.owner_id == actor.id,
        and_(user_allow, not_(user_deny)),
        and_(not_(user_decision), role_allow, not_(role_deny)),
        and_(not_(user_decision), not_(role_decision), everyone_allow, not_(everyone_deny)),
    )


def _board_with_access(
    db: Session,
    actor: User,
    board_id: UUID,
    action: BoardPermission,
    *,
    lock: bool = False,
) -> Board:
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

    grants = db.scalars(
        select(BoardGrant).where(
            BoardGrant.board_id == board.id,
            BoardGrant.is_deleted.is_(False),
            BoardGrant.deleted_at.is_(None),
        )
    ).all()
    if not can_access_board(board, actor, action, grants):
        raise _not_found()
    return board


def _validate_department(db: Session, department_id: UUID | None) -> None:
    if department_id is None:
        return
    department = db.scalar(
        select(Department.id)
        .where(
            Department.id == department_id,
            Department.is_deleted.is_(False),
            Department.deleted_at.is_(None),
        )
        .with_for_update()
    )
    if department is None:
        raise _conflict("department_unavailable", "The selected department is unavailable")


def _commit(db: Session, code: str, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict(code, message) from error


def _response(board: Board) -> BoardResponse:
    return BoardResponse.model_validate(board)


@router.get("", response_model=BoardListResponse)
def list_boards(
    user: Reader,
    db: Database,
    params: Annotated[BoardListRequest, Query()],
) -> BoardListResponse:
    statement = select(Board).where(
        Board.is_deleted.is_(False),
        Board.deleted_at.is_(None),
        _board_view_clause(user),
    )
    if params.status is not BoardStatusFilter.ALL:
        statement = statement.where(Board.status == params.status.value)
    if params.department_id is not None:
        statement = statement.where(Board.department_id == params.department_id)
    if params.favorites_only:
        statement = statement.where(
            exists(
                select(BoardFavorite.id).where(
                    BoardFavorite.user_id == user.id,
                    BoardFavorite.board_id == Board.id,
                    BoardFavorite.is_deleted.is_(False),
                    BoardFavorite.deleted_at.is_(None),
                )
            )
        )

    result = execute_standard_list(db, statement, params, BOARD_LIST_SPEC)
    return BoardListResponse(
        items=[_response(board) for board in result.items],
        pagination=result.pagination,
    )


@router.post("", response_model=BoardResponse, status_code=status.HTTP_201_CREATED)
def create_board(
    payload: BoardCreate,
    user: Writer,
    db: Database,
    response: Response,
) -> BoardResponse:
    _validate_department(db, payload.department_id)
    board = Board(
        owner_id=user.id,
        department_id=payload.department_id,
        name=payload.name,
        description=payload.description,
        status=BoardStatus.ACTIVE,
        default_section=payload.default_section,
    )
    db.add(board)
    _commit(db, "board_invalid", "Unable to create Board")
    db.refresh(board)
    response.headers["Location"] = f"/api/boards/{board.id}"
    return _response(board)


@router.get("/{board_id}", response_model=BoardResponse)
def read_board(board_id: UUID, user: Reader, db: Database) -> BoardResponse:
    return _response(_board_with_access(db, user, board_id, BoardPermission.VIEW))


@router.patch("/{board_id}", response_model=BoardResponse)
def update_board(
    board_id: UUID,
    payload: BoardUpdate,
    user: Writer,
    db: Database,
) -> BoardResponse:
    board = _board_with_access(db, user, board_id, BoardPermission.MANAGE, lock=True)
    if board.revision != payload.revision:
        raise _stale_revision(board.revision)
    if board.status == BoardStatus.ARCHIVED:
        raise _conflict("board_archived", "Restore the Board before editing it")

    changes = payload.model_fields_set - {"revision"}
    if "department_id" in changes:
        _validate_department(db, payload.department_id)

    name = payload.name if payload.name is not None else board.name
    description = payload.description if "description" in changes else board.description
    department_id = payload.department_id if "department_id" in changes else board.department_id
    default_section = (
        payload.default_section
        if payload.default_section is not None
        else board.default_section
    )
    if (
        name == board.name
        and description == board.description
        and department_id == board.department_id
        and default_section == board.default_section
    ):
        return _response(board)

    board.name = name
    board.description = description
    board.department_id = department_id
    board.default_section = default_section
    board.revision += 1
    _commit(db, "board_invalid", "Unable to update Board")
    db.refresh(board)
    return _response(board)


@router.post("/{board_id}/archive", response_model=BoardResponse)
def archive_board(
    board_id: UUID,
    payload: BoardRevisionRequest,
    user: Writer,
    db: Database,
) -> BoardResponse:
    board = _board_with_access(db, user, board_id, BoardPermission.MANAGE, lock=True)
    if board.revision != payload.revision:
        raise _stale_revision(board.revision)
    if board.status == BoardStatus.ARCHIVED:
        raise _conflict("board_archived", "The Board is already archived")
    board.status = BoardStatus.ARCHIVED
    board.revision += 1
    _commit(db, "board_invalid", "Unable to archive Board")
    db.refresh(board)
    return _response(board)


@router.post("/{board_id}/restore", response_model=BoardResponse)
def restore_board(
    board_id: UUID,
    payload: BoardRevisionRequest,
    user: Writer,
    db: Database,
) -> BoardResponse:
    board = _board_with_access(db, user, board_id, BoardPermission.MANAGE, lock=True)
    if board.revision != payload.revision:
        raise _stale_revision(board.revision)
    if board.status != BoardStatus.ARCHIVED:
        raise _conflict("board_not_archived", "The Board is not archived")
    board.status = BoardStatus.ACTIVE
    board.revision += 1
    _commit(db, "board_invalid", "Unable to restore Board")
    db.refresh(board)
    return _response(board)
