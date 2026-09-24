"""Current-user Board preference routes; not yet mounted in the application."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, StrictBool
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, joinedload

from app.common.dependencies import require_legacy_capability
from app.core.database import get_db
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.models import User, UserStatus
from app.systems.access.users.permissions import Capability, has_capability
from app.systems.boards.models import Board, BoardPermission, BoardStatus
from app.systems.boards.personal_models import BoardFavorite, BoardHome
from app.systems.boards.router import _board_view_clause, _board_with_access


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(
    prefix="/boards/personal", tags=["boards"], dependencies=[Depends(_private_cache)]
)
Reader = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_READ))]
Database = Annotated[Session, Depends(get_db)]


class BoardPersonalState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    favorite_board_ids: list[UUID]
    home_board_id: UUID | None


class HomeBoardWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    board_id: UUID | None


class FavoriteBoardWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    favorite: StrictBool


def _conflict(code: str, message: str) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, detail={"code": code, "message": message})


def _current_state(db: Session, actor: User) -> BoardPersonalState:
    visible_board = _board_view_clause(actor)
    favorites = db.scalars(
        select(BoardFavorite.board_id)
        .join(Board, Board.id == BoardFavorite.board_id)
        .where(
            BoardFavorite.user_id == actor.id,
            BoardFavorite.is_deleted.is_(False),
            BoardFavorite.deleted_at.is_(None),
            Board.is_deleted.is_(False),
            Board.deleted_at.is_(None),
            visible_board,
        )
        .order_by(BoardFavorite.board_id)
    ).all()
    home = db.scalar(
        select(BoardHome.board_id)
        .join(Board, Board.id == BoardHome.board_id)
        .where(
            BoardHome.user_id == actor.id,
            BoardHome.is_deleted.is_(False),
            BoardHome.deleted_at.is_(None),
            Board.is_deleted.is_(False),
            Board.deleted_at.is_(None),
            Board.status == BoardStatus.ACTIVE,
            visible_board,
        )
    )
    return BoardPersonalState(favorite_board_ids=list(favorites), home_board_id=home)


def _locked_actor(db: Session, actor: User) -> User:
    current = db.scalar(
        select(User)
        .options(joinedload(User.role))
        .where(User.id == actor.id)
        .with_for_update(of=User)
        .execution_options(populate_existing=True)
    )
    if (
        current is None
        or current.status != UserStatus.ACTIVE.value
        or current.is_deleted
        or current.deleted_at is not None
        or not is_established_user(current)
        or current.role is None
        or current.role.is_deleted
        or current.role.deleted_at is not None
        or current.role_id != current.role.id
        or not has_capability(current.role, Capability.RECORDS_READ)
    ):
        db.rollback()
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Forbidden")
    return current


def _save(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict("personal_state_conflict", "Board preferences changed; retry") from error
    except SQLAlchemyError:
        db.rollback()
        raise


@router.get("", response_model=BoardPersonalState)
def get_personal_boards(actor: Reader, db: Database) -> BoardPersonalState:
    return _current_state(db, actor)


@router.put("/home", response_model=BoardPersonalState)
def set_home_board(payload: HomeBoardWrite, actor: Reader, db: Database) -> BoardPersonalState:
    actor = _locked_actor(db, actor)
    if payload.board_id is not None:
        board = _board_with_access(db, actor, payload.board_id, BoardPermission.VIEW, lock=True)
        if board.status != BoardStatus.ACTIVE:
            db.rollback()
            raise _conflict("home_board_archived", "Restore the Board before setting it as home")
    home = db.scalar(
        select(BoardHome)
        .where(BoardHome.user_id == actor.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if payload.board_id is None:
        if home is not None:
            db.delete(home)
            _save(db)
    elif home is None:
        db.add(BoardHome(user_id=actor.id, board_id=payload.board_id))
        _save(db)
    elif home.board_id != payload.board_id or home.is_deleted or home.deleted_at is not None:
        home.board_id = payload.board_id
        home.is_deleted = False
        home.deleted_at = None
        _save(db)
    return _current_state(db, actor)


@router.put("/favorites/{board_id}", response_model=BoardPersonalState)
def set_favorite_board(
    board_id: UUID, payload: FavoriteBoardWrite, actor: Reader, db: Database
) -> BoardPersonalState:
    actor = _locked_actor(db, actor)
    _board_with_access(db, actor, board_id, BoardPermission.VIEW, lock=True)
    favorite = db.scalar(
        select(BoardFavorite)
        .where(BoardFavorite.user_id == actor.id, BoardFavorite.board_id == board_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if payload.favorite:
        if favorite is None:
            db.add(BoardFavorite(user_id=actor.id, board_id=board_id))
            _save(db)
        elif favorite.is_deleted or favorite.deleted_at is not None:
            favorite.is_deleted = False
            favorite.deleted_at = None
            _save(db)
    elif favorite is not None and not favorite.is_deleted and favorite.deleted_at is None:
        db.delete(favorite)
        _save(db)
    return _current_state(db, actor)
