"""Board labels: readers list them, managers define them, writers apply them to cards."""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user
from app.common.listing import ListQuerySpec, execute_standard_list
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.kanban_models import BoardCardLabel, BoardLabel
from app.systems.boards.kanban_schemas import (
    LabelCreate,
    LabelListRequest,
    LabelListResponse,
    LabelPatch,
    LabelResponse,
    LabelSort,
    RevisionWrite,
)
from app.systems.boards.kanban_service import (
    MAX_LABELS,
    check_revision,
    commit,
    kanban_error,
    not_found,
    read_board,
    write_board,
)


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(
    prefix="/boards", tags=["board kanban"], dependencies=[Depends(_private_cache)]
)
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]

LABEL_LIST_SPEC = ListQuerySpec(
    sort_fields={
        LabelSort.POSITION: cast(ColumnElement[Any], BoardLabel.position),
        LabelSort.NAME: cast(ColumnElement[Any], func.lower(BoardLabel.name)),
    },
    default_sort=LabelSort.POSITION,
    tie_breaker=cast(ColumnElement[Any], BoardLabel.id),
    search_fields=(cast(ColumnElement[str], BoardLabel.name),),
)
_NAME_TAKEN = ("label_name_taken", "Another label on this Board has that name")


def _label(db: Session, board_id: UUID, label_id: UUID) -> BoardLabel:
    found = db.scalar(
        select(BoardLabel)
        .where(BoardLabel.id == label_id, BoardLabel.board_id == board_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if found is None:
        raise not_found("Label")
    return found


def _name_free(db: Session, board_id: UUID, name: str, exclude: UUID | None = None) -> None:
    statement = select(BoardLabel.id).where(
        BoardLabel.board_id == board_id, func.lower(BoardLabel.name) == name.lower()
    )
    if exclude is not None:
        statement = statement.where(BoardLabel.id != exclude)
    if db.scalar(statement) is not None:
        raise kanban_error(*_NAME_TAKEN)


@router.get("/{board_id}/labels", response_model=LabelListResponse)
def list_board_labels(
    board_id: UUID, actor: Reader, db: Database, params: Annotated[LabelListRequest, Query()]
) -> LabelListResponse:
    board = read_board(db, actor, board_id)
    result = execute_standard_list(
        db, select(BoardLabel).where(BoardLabel.board_id == board.id), params, LABEL_LIST_SPEC
    )
    return LabelListResponse(
        items=[LabelResponse.model_validate(row) for row in result.items],
        pagination=result.pagination,
    )


@router.post(
    "/{board_id}/labels", response_model=LabelResponse, status_code=status.HTTP_201_CREATED
)
def create_board_label(
    board_id: UUID, payload: LabelCreate, actor: Reader, db: Database
) -> LabelResponse:
    board = write_board(db, actor, board_id, AccessLevel.MANAGE)
    positions = list(db.scalars(select(BoardLabel.position).where(BoardLabel.board_id == board.id)))
    if len(positions) >= MAX_LABELS:
        raise kanban_error("label_limit", "A Board has at most 20 labels")
    _name_free(db, board.id, payload.name)
    row = BoardLabel(
        org_id=board.org_id, board_id=board.id, name=payload.name, color=payload.color,
        position=max(positions, default=-1) + 1,
    )
    db.add(row)
    commit(db, *_NAME_TAKEN)
    db.refresh(row)
    return LabelResponse.model_validate(row)


@router.patch("/{board_id}/labels/{label_id}", response_model=LabelResponse)
def update_board_label(
    board_id: UUID, label_id: UUID, payload: LabelPatch, actor: Reader, db: Database
) -> LabelResponse:
    board = write_board(db, actor, board_id, AccessLevel.MANAGE)
    row = _label(db, board.id, label_id)
    check_revision(row, payload.revision, "stale_label_revision")
    if payload.name is not None:
        _name_free(db, board.id, payload.name, exclude=row.id)
        row.name = payload.name
    if payload.color is not None:
        row.color = payload.color
    if payload.name is not None or payload.color is not None:
        row.revision += 1
    commit(db, *_NAME_TAKEN)
    db.refresh(row)
    return LabelResponse.model_validate(row)


@router.delete("/{board_id}/labels/{label_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_board_label(
    board_id: UUID, label_id: UUID, payload: RevisionWrite, actor: Reader, db: Database
) -> None:
    """Remove the label and take it off every card that carries it."""

    board = write_board(db, actor, board_id, AccessLevel.MANAGE)
    row = _label(db, board.id, label_id)
    check_revision(row, payload.revision, "stale_label_revision")
    for applied in db.scalars(
        select(BoardCardLabel)
        .where(BoardCardLabel.label_id == row.id)
        .order_by(BoardCardLabel.id)
        .with_for_update()
    ):
        db.delete(applied)
    db.flush()
    db.delete(row)
    commit(db, "label_conflict", "Unable to remove the label; reload the Board")
