"""Private Board record-shortcut API; registered only with the complete Board surface."""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user, require_non_guest
from app.common.listing import ListQuerySpec, execute_standard_list
from app.core.database import get_db
from app.systems.access.policy.checks import module_filter, module_level
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.models import Board, BoardPermission, BoardRecordPlacement, BoardStatus
from app.systems.boards.placement_schemas import (
    BoardPlacementCreate,
    BoardPlacementListRequest,
    BoardPlacementListResponse,
    BoardPlacementMutationResponse,
    BoardPlacementResponse,
    BoardPlacementSort,
)
from app.systems.boards.router import _board_with_access
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(get_current_user)]
Writer = Annotated[User, Depends(require_non_guest)]
Database = Annotated[Session, Depends(get_db)]

PLACEMENT_LIST_SPEC = ListQuerySpec(
    sort_fields={
        BoardPlacementSort.CREATED_AT: cast(ColumnElement[Any], BoardRecordPlacement.created_at),
        BoardPlacementSort.UPDATED_AT: cast(ColumnElement[Any], BoardRecordPlacement.updated_at),
    },
    default_sort=BoardPlacementSort.CREATED_AT,
    tie_breaker=cast(ColumnElement[Any], BoardRecordPlacement.id),
    deleted_field=None,
)


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail="Board placement not found")


def _conflict(code: str, message: str, **extra: int) -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT,
        detail={"code": code, "message": message, **extra},
    )


def _editable(board: Board, revision: int) -> None:
    if board.revision != revision:
        raise _conflict(
            "stale_revision",
            "Board changed; reload before saving",
            current_revision=board.revision,
        )
    if board.status == BoardStatus.ARCHIVED:
        raise _conflict("board_archived", "Restore the Board before changing shortcuts")


def _active_record(db: Session, actor: User, record_id: UUID) -> Record:
    module_id = db.scalar(select(Record.module_id).where(Record.id == record_id))
    if module_id is None or module_level(db, actor, module_id) is None:
        raise _conflict("record_unavailable", "The selected record is unavailable")
    module = db.scalar(
        select(Module)
        .where(
            Module.id == module_id,
            Module.is_deleted.is_(False),
            Module.deleted_at.is_(None),
        )
        .with_for_update()
    )
    if module is None:
        raise _conflict("record_unavailable", "The selected record is unavailable")
    record = db.scalar(
        select(Record)
        .where(Record.id == record_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if (
        record is None
        or record.module_id != module.id
        or record.is_deleted
        or record.deleted_at is not None
    ):
        raise _conflict("record_unavailable", "The selected record is unavailable")
    return record


def _available_modules(
    db: Session, actor: User, placements: list[BoardRecordPlacement]
) -> dict[UUID, UUID]:
    if not placements:
        return {}
    record_ids = [placement.record_id for placement in placements]
    rows = db.execute(
        select(Record.id, Record.module_id)
        .join(Module, Module.id == Record.module_id)
        .where(
            Record.id.in_(record_ids),
            Record.is_deleted.is_(False),
            Record.deleted_at.is_(None),
            Module.is_deleted.is_(False),
            Module.deleted_at.is_(None),
            module_filter(db, actor, AccessLevel.READ, Record.module_id),
        )
    ).all()
    return {record_id: module_id for record_id, module_id in rows}


def _response(
    placement: BoardRecordPlacement, module_id: UUID | None
) -> BoardPlacementResponse:
    return BoardPlacementResponse(
        id=placement.id,
        board_id=placement.board_id,
        record_id=placement.record_id,
        module_id=module_id,
        available=module_id is not None,
        created_at=placement.created_at,
        updated_at=placement.updated_at,
    )


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        constraint = getattr(getattr(error.orig, "diag", None), "constraint_name", None)
        if constraint == "uq_board_record_placements_board_record":
            raise _conflict(
                "placement_exists", "This record is already linked to the Board"
            ) from error
        raise _conflict("placement_invalid", "The record shortcut could not be saved") from error


@router.get("/{board_id}/placements", response_model=BoardPlacementListResponse)
def list_board_placements(
    board_id: UUID,
    user: Reader,
    db: Database,
    params: Annotated[BoardPlacementListRequest, Query()],
) -> BoardPlacementListResponse:
    board = _board_with_access(db, user, board_id, BoardPermission.VIEW)
    result = execute_standard_list(
        db,
        select(BoardRecordPlacement).where(
            BoardRecordPlacement.board_id == board.id,
            BoardRecordPlacement.is_deleted.is_(False),
            BoardRecordPlacement.deleted_at.is_(None),
        ),
        params,
        PLACEMENT_LIST_SPEC,
    )
    modules = _available_modules(db, user, result.items)
    return BoardPlacementListResponse(
        items=[
            _response(placement, modules.get(placement.record_id)) for placement in result.items
        ],
        pagination=result.pagination,
        board_revision=board.revision,
    )


@router.post(
    "/{board_id}/placements",
    response_model=BoardPlacementMutationResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_board_placement(
    board_id: UUID,
    payload: BoardPlacementCreate,
    user: Writer,
    db: Database,
    response: Response,
) -> BoardPlacementMutationResponse:
    board = _board_with_access(db, user, board_id, BoardPermission.EDIT, lock=True)
    _editable(board, payload.revision)
    record = _active_record(db, user, payload.record_id)
    existing = db.scalar(
        select(BoardRecordPlacement.id).where(
            BoardRecordPlacement.board_id == board.id,
            BoardRecordPlacement.record_id == record.id,
        )
    )
    if existing is not None:
        raise _conflict("placement_exists", "This record is already linked to the Board")
    placement = BoardRecordPlacement(board_id=board.id, record_id=record.id)
    db.add(placement)
    board.revision += 1
    _commit(db)
    db.refresh(placement)
    response.headers["Location"] = f"/api/boards/{board.id}/placements/{placement.id}"
    return BoardPlacementMutationResponse(
        placement=_response(placement, record.module_id),
        board_revision=board.revision,
    )


@router.delete("/{board_id}/placements/{placement_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_board_placement(
    board_id: UUID,
    placement_id: UUID,
    revision: Annotated[int, Query(ge=1)],
    user: Writer,
    db: Database,
    response: Response,
) -> Response:
    board = _board_with_access(db, user, board_id, BoardPermission.EDIT, lock=True)
    _editable(board, revision)
    placement = db.scalar(
        select(BoardRecordPlacement)
        .where(
            BoardRecordPlacement.id == placement_id,
            BoardRecordPlacement.board_id == board.id,
            BoardRecordPlacement.is_deleted.is_(False),
            BoardRecordPlacement.deleted_at.is_(None),
        )
        .with_for_update()
    )
    if placement is None:
        raise _not_found()
    db.delete(placement)
    board.revision += 1
    _commit(db)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response
