"""Kanban stages: readers list them; managers add, change, order and archive them."""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user
from app.common.listing import ListQuerySpec, execute_standard_list
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.kanban_models import BoardCard, BoardStage
from app.systems.boards.kanban_schemas import (
    StageArchive,
    StageCreate,
    StageItems,
    StageListRequest,
    StageListResponse,
    StageOrder,
    StagePatch,
    StageResponse,
    StageSort,
)
from app.systems.boards.kanban_service import (
    MAX_STAGES,
    active_stage,
    check_revision,
    commit,
    kanban_error,
    now,
    place,
    read_board,
    stage,
    stage_card_counts,
    write_board,
)


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(
    prefix="/boards", tags=["board kanban"], dependencies=[Depends(_private_cache)]
)
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]

STAGE_LIST_SPEC = ListQuerySpec(
    sort_fields={StageSort.POSITION: cast(ColumnElement[Any], BoardStage.position)},
    default_sort=StageSort.POSITION,
    tie_breaker=cast(ColumnElement[Any], BoardStage.id),
)


def _response(row: BoardStage, count: int) -> StageResponse:
    return StageResponse.model_validate({
        "id": row.id, "board_id": row.board_id, "name": row.name, "color": row.color,
        "wip_limit": row.wip_limit, "card_sort": row.card_sort, "position": row.position,
        "revision": row.revision, "archived_at": row.archived_at, "card_count": count,
    })


def _active(db: Session, board_id: UUID) -> list[BoardStage]:
    return list(
        db.scalars(
            select(BoardStage)
            .where(
                BoardStage.board_id == board_id,
                BoardStage.archived_at.is_(None),
                BoardStage.is_deleted.is_(False),
            )
            .order_by(BoardStage.position, BoardStage.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )


@router.get("/{board_id}/stages", response_model=StageListResponse)
def list_board_stages(
    board_id: UUID, actor: Reader, db: Database, params: Annotated[StageListRequest, Query()]
) -> StageListResponse:
    """Active stages in board order, each with its active card count."""

    board = read_board(db, actor, board_id)
    result = execute_standard_list(
        db,
        select(BoardStage).where(
            BoardStage.board_id == board.id,
            BoardStage.archived_at.is_(None),
            BoardStage.is_deleted.is_(False),
        ),
        params,
        STAGE_LIST_SPEC,
    )
    counts = stage_card_counts(db, [row.id for row in result.items])
    return StageListResponse(
        items=[_response(row, counts.get(row.id, 0)) for row in result.items],
        pagination=result.pagination,
    )


@router.post(
    "/{board_id}/stages", response_model=StageResponse, status_code=status.HTTP_201_CREATED
)
def create_board_stage(
    board_id: UUID, payload: StageCreate, actor: Reader, db: Database
) -> StageResponse:
    board = write_board(db, actor, board_id, AccessLevel.MANAGE)
    stages = _active(db, board.id)
    if len(stages) >= MAX_STAGES:
        raise kanban_error("stage_limit", "A Board has at most 20 active stages")
    row = BoardStage(
        org_id=board.org_id, board_id=board.id, name=payload.name, color=payload.color,
        wip_limit=payload.wip_limit, card_sort=payload.card_sort,
        position=max((item.position for item in stages), default=-1) + 1,
    )
    db.add(row)
    commit(db, "stage_conflict", "Unable to add the stage; reload the Board")
    db.refresh(row)
    return _response(row, 0)


@router.patch("/{board_id}/stages/{stage_id}", response_model=StageResponse)
def update_board_stage(
    board_id: UUID, stage_id: UUID, payload: StagePatch, actor: Reader, db: Database
) -> StageResponse:
    board = write_board(db, actor, board_id, AccessLevel.MANAGE)
    row = stage(db, board.id, stage_id, lock=True)
    check_revision(row, payload.revision, "stale_stage_revision")
    if row.archived_at is not None:
        raise kanban_error("stage_archived", "The stage is archived")
    changes = payload.model_dump(exclude_unset=True, exclude={"revision"})
    for key, value in changes.items():
        setattr(row, key, value)
    if changes:
        row.revision += 1
    commit(db, "stage_conflict", "Unable to save the stage; reload the Board")
    db.refresh(row)
    return _response(row, stage_card_counts(db, [row.id]).get(row.id, 0))


@router.put("/{board_id}/stages/order", response_model=StageItems)
def order_board_stages(
    board_id: UUID, payload: StageOrder, actor: Reader, db: Database
) -> StageItems:
    """Set the order of every active stage; the list must name each exactly once."""

    board = write_board(db, actor, board_id, AccessLevel.MANAGE)
    stages = {row.id: row for row in _active(db, board.id)}
    if set(payload.stage_ids) != stages.keys():
        raise kanban_error("stage_order_stale", "The stages changed; reload the Board")
    for row in stages.values():
        row.position += 10_000_000
    db.flush()
    for position, identity in enumerate(payload.stage_ids):
        stages[identity].position = position
    commit(db, "stage_conflict", "Unable to order the stages; reload the Board")
    counts = stage_card_counts(db, list(stages))
    return StageItems(
        items=[_response(stages[identity], counts.get(identity, 0))
               for identity in payload.stage_ids]
    )


@router.post("/{board_id}/stages/{stage_id}/archive", response_model=StageResponse)
def archive_board_stage(
    board_id: UUID, stage_id: UUID, payload: StageArchive, actor: Reader, db: Database
) -> StageResponse:
    """Archive a stage; its active cards move to another active stage or archive too."""

    board = write_board(db, actor, board_id, AccessLevel.MANAGE)
    row = stage(db, board.id, stage_id, lock=True)
    check_revision(row, payload.revision, "stale_stage_revision")
    if row.archived_at is not None:
        raise kanban_error("stage_archived", "The stage is already archived")
    target = None
    if payload.target_stage_id is not None:
        if payload.target_stage_id == row.id:
            raise kanban_error("stage_unavailable", "Move the cards to another stage")
        target = active_stage(db, board.id, payload.target_stage_id)
    cards = list(
        db.scalars(
            select(BoardCard)
            .where(
                BoardCard.stage_id == row.id,
                BoardCard.archived_at.is_(None),
                BoardCard.is_deleted.is_(False),
            )
            .order_by(BoardCard.rank, BoardCard.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    timestamp = now()
    for item in cards:
        if target is not None:
            place(db, item, target.id, None)
        else:
            item.archived_at = timestamp
        item.revision += 1
        db.flush()
    row.archived_at = timestamp
    row.revision += 1
    commit(db, "stage_conflict", "Unable to archive the stage; reload the Board")
    db.refresh(row)
    return _response(row, 0)

