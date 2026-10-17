"""Board tiles: every reader sees them; managers add, change, order and remove them."""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user
from app.common.dependencies.auth import CurrentIdentity, get_current_identity
from app.common.listing import ListQuerySpec, execute_standard_list
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.models import Board, BoardStatus, BoardWidget
from app.systems.boards.router import _board_with_access
from app.systems.boards.widget_schemas import (
    BoardWidgetConfig,
    BoardWidgetListRequest,
    BoardWidgetListResponse,
    BoardWidgetMutationResponse,
    BoardWidgetOrder,
    BoardWidgetOrderResponse,
    BoardWidgetResponse,
    BoardWidgetRevision,
    BoardWidgetSort,
    BoardWidgetSpec,
    BoardWidgetWrite,
)
from app.systems.openview.charts import service as charts
from app.systems.openview.dashboards.schemas import DashboardChartConfig
from app.systems.sandbox.records.query import validate_definition
from app.systems.sandbox.records.query_schemas import QueryDefinition


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(get_current_user)]
SourceWriter = Annotated[CurrentIdentity, Depends(get_current_identity)]
Database = Annotated[Session, Depends(get_db)]

WIDGET_LIST_SPEC = ListQuerySpec(
    sort_fields={
        BoardWidgetSort.POSITION: cast(ColumnElement[Any], BoardWidget.position),
        BoardWidgetSort.CREATED_AT: cast(ColumnElement[Any], BoardWidget.created_at),
    },
    default_sort=BoardWidgetSort.POSITION,
    tie_breaker=cast(ColumnElement[Any], BoardWidget.id),
    deleted_field=None,
)


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail="Board widget not found")


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
        raise _conflict("board_archived", "Restore the Board before changing widgets")


def _active_widgets(
    db: Session, board_id: UUID, *, lock: bool = False, nowait: bool = False
) -> list[BoardWidget]:
    statement = (
        select(BoardWidget)
        .where(
            BoardWidget.board_id == board_id,
            BoardWidget.is_deleted.is_(False),
            BoardWidget.deleted_at.is_(None),
        )
        .order_by(BoardWidget.position, BoardWidget.id)
    )
    if lock:
        statement = statement.with_for_update(nowait=nowait).execution_options(
            populate_existing=True
        )
        if nowait:
            statement = statement.order_by(None).order_by(BoardWidget.id)
    rows = list(db.scalars(statement).all())
    return sorted(rows, key=lambda item: (item.position, item.id))


def _response(widget: BoardWidget) -> BoardWidgetResponse:
    try:
        return BoardWidgetResponse.model_validate(
            {
                "id": widget.id,
                "board_id": widget.board_id,
                "name": widget.name,
                "widget_type": widget.widget_type,
                "module_id": widget.module_id,
                "position": widget.position,
                "config": widget.config,
                "chart_id": widget.chart_id,
                "size": widget.size,
                "pinned": widget.pinned,
                "created_at": widget.created_at,
                "updated_at": widget.updated_at,
            }
        )
    except ValidationError:
        raise _not_found() from None


def _validate_source(db: Session, identity: CurrentIdentity, widget: BoardWidgetSpec) -> User:
    try:
        _, references, actor = charts.lock_widget_sources(
            db,
            identity,
            {widget.module_id} if widget.config is not None else set(),
            {widget.chart_id} if widget.chart_id is not None else set(),
        )
        if widget.chart_id is not None:
            chart = references[widget.chart_id]
            category = (
                chart.chart_type
                if chart.chart_type in {"summary", "workload", "records"}
                else "chart"
            )
            if chart.module_id != widget.module_id or category != widget.widget_type:
                raise charts.invalid_chart()
        elif isinstance(widget.config, BoardWidgetConfig):
            config = widget.config
            definition = QueryDefinition(
                columns=config.fields, filters=config.filters, logic=config.logic
            )
            fields = validate_definition(
                db,
                widget.module_id,
                definition,
                extra_references=(config.metric,) if config.metric is not None else (),
                reader=actor,
            )
            ids = {
                item.field_id
                for item in (
                    *config.fields,
                    *config.filters,
                    *((config.metric,) if config.metric else ()),
                )
            }
            if any(fields[key].is_deleted or fields[key].deleted_at is not None for key in ids):
                raise charts.invalid_chart()
        else:
            normalized = widget.config
            assert normalized is not None
            kind = (
                normalized.chart_type
                if isinstance(normalized, DashboardChartConfig)
                else widget.widget_type
            )
            charts.validate_query(db, actor, widget.module_id, kind, normalized.query)
        return actor
    except HTTPException as error:
        if error.status_code == 409:
            raise _conflict(
                "widget_invalid", "The selected Chart, module or fields are unavailable"
            ) from error
        raise


def _write(widget: BoardWidget, payload: BoardWidgetSpec) -> None:
    widget.name = payload.name
    widget.widget_type = payload.widget_type
    widget.module_id = payload.module_id
    widget.chart_id = payload.chart_id
    widget.size = payload.size
    widget.pinned = payload.pinned
    widget.config = (
        payload.config.model_dump(mode="json", exclude={"refresh"})
        if payload.config is not None
        else None
    )


def _locked_consumer(db: Session, actor: User, board_id: UUID, revision: int) -> Board:
    # Every source lock was acquired first; never block behind Board→Group writers.
    board = db.scalar(
        select(Board)
        .where(Board.id == board_id, Board.is_deleted.is_(False), Board.deleted_at.is_(None))
        .with_for_update(nowait=True)
        .execution_options(populate_existing=True)
    )
    if board is None:
        raise _not_found()
    board = _board_with_access(db, actor, board_id, AccessLevel.MANAGE)
    _editable(board, revision)
    return board


def _source_spec(widget: BoardWidget) -> BoardWidgetSpec:
    return BoardWidgetSpec(
        name=widget.name,
        widget_type=widget.widget_type,
        module_id=widget.module_id,
        config=widget.config,
        chart_id=widget.chart_id,
        size=widget.size,
        pinned=widget.pinned,
    )


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict("widget_invalid", "Unable to save Board widget") from error


@router.get("/{board_id}/widgets", response_model=BoardWidgetListResponse)
def list_board_widgets(
    board_id: UUID,
    user: Reader,
    db: Database,
    params: Annotated[BoardWidgetListRequest, Query()],
) -> BoardWidgetListResponse:
    board = _board_with_access(db, user, board_id, AccessLevel.READ)
    result = execute_standard_list(
        db,
        select(BoardWidget).where(
            BoardWidget.board_id == board.id,
            BoardWidget.is_deleted.is_(False),
            BoardWidget.deleted_at.is_(None),
        ),
        params,
        WIDGET_LIST_SPEC,
    )
    return BoardWidgetListResponse(
        items=[_response(widget) for widget in result.items],
        pagination=result.pagination,
        board_revision=board.revision,
    )


@router.post(
    "/{board_id}/widgets",
    response_model=BoardWidgetMutationResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_board_widget(
    board_id: UUID,
    payload: BoardWidgetWrite,
    identity: SourceWriter,
    db: Database,
    response: Response,
) -> BoardWidgetMutationResponse:
    with charts.widget_source_transaction(db):
        board = _board_with_access(db, get_current_user(identity), board_id, AccessLevel.MANAGE)
        _editable(board, payload.revision)
        actor = _validate_source(db, identity, payload.widget)
        board = _locked_consumer(db, actor, board_id, payload.revision)
        widgets = _active_widgets(db, board.id, lock=True, nowait=True)
        if len(widgets) >= 12:
            raise _conflict("widget_limit", "A Board can contain at most 12 widgets")
        widget = BoardWidget(org_id=board.org_id, board_id=board.id, position=len(widgets))
        _write(widget, payload.widget)
        db.add(widget)
        board.revision += 1
        _commit(db)
        db.refresh(widget)
        response.headers["Location"] = f"/api/boards/{board.id}/widgets/{widget.id}"
        return BoardWidgetMutationResponse(widget=_response(widget), board_revision=board.revision)


@router.patch("/{board_id}/widgets/{widget_id}", response_model=BoardWidgetMutationResponse)
def update_board_widget(
    board_id: UUID, widget_id: UUID, payload: BoardWidgetWrite, identity: SourceWriter, db: Database
) -> BoardWidgetMutationResponse:
    with charts.widget_source_transaction(db):
        board = _board_with_access(db, get_current_user(identity), board_id, AccessLevel.MANAGE)
        _editable(board, payload.revision)
        if not any(item.id == widget_id for item in _active_widgets(db, board.id)):
            raise _not_found()
        actor = _validate_source(db, identity, payload.widget)
        board = _locked_consumer(db, actor, board_id, payload.revision)
        widget = next(
            (
                item
                for item in _active_widgets(db, board.id, lock=True, nowait=True)
                if item.id == widget_id
            ),
            None,
        )
        if widget is None:
            raise _not_found()
        _write(widget, payload.widget)
        board.revision += 1
        _commit(db)
        db.refresh(widget)
        return BoardWidgetMutationResponse(widget=_response(widget), board_revision=board.revision)


@router.post(
    "/{board_id}/widgets/{widget_id}/duplicate",
    response_model=BoardWidgetMutationResponse,
    status_code=status.HTTP_201_CREATED,
)
def duplicate_board_widget(
    board_id: UUID,
    widget_id: UUID,
    payload: BoardWidgetRevision,
    identity: SourceWriter,
    db: Database,
    response: Response,
) -> BoardWidgetMutationResponse:
    with charts.widget_source_transaction(db):
        board = _board_with_access(db, get_current_user(identity), board_id, AccessLevel.MANAGE)
        _editable(board, payload.revision)
        discovered = next(
            (item for item in _active_widgets(db, board.id) if item.id == widget_id), None
        )
        if discovered is None:
            raise _not_found()
        source_spec = _source_spec(discovered)
        actor = _validate_source(db, identity, source_spec)
        board = _locked_consumer(db, actor, board_id, payload.revision)
        widgets = _active_widgets(db, board.id, lock=True, nowait=True)
        source = next((item for item in widgets if item.id == widget_id), None)
        if source is None:
            raise _not_found()
        if _source_spec(source) != source_spec:
            raise _conflict(
                "widget_invalid", "The source widget changed; reload before duplicating"
            )
        if len(widgets) >= 12:
            raise _conflict("widget_limit", "A Board can contain at most 12 widgets")
        duplicate = BoardWidget(org_id=board.org_id, board_id=board.id, position=len(widgets))
        _write(duplicate, source_spec)
        db.add(duplicate)
        board.revision += 1
        _commit(db)
        db.refresh(duplicate)
        response.headers["Location"] = f"/api/boards/{board.id}/widgets/{duplicate.id}"
        return BoardWidgetMutationResponse(
            widget=_response(duplicate), board_revision=board.revision
        )


@router.put("/{board_id}/widgets/order", response_model=BoardWidgetOrderResponse)
def reorder_board_widgets(
    board_id: UUID, payload: BoardWidgetOrder, user: Reader, db: Database
) -> BoardWidgetOrderResponse:
    board = _board_with_access(db, user, board_id, AccessLevel.MANAGE, lock=True)
    _editable(board, payload.revision)
    visible = _active_widgets(db, board.id, lock=True)
    if set(payload.widget_ids) != {item.id for item in visible}:
        raise _conflict("widget_order_invalid", "Order must contain every Board widget")
    positions = sorted(item.position for item in visible)
    by_id = {item.id: item for item in visible}
    for widget_id, position in zip(payload.widget_ids, positions, strict=True):
        by_id[widget_id].position = position
    board.revision += 1
    _commit(db)
    ordered = sorted(visible, key=lambda item: (item.position, item.id))
    return BoardWidgetOrderResponse(
        items=[_response(widget) for widget in ordered], board_revision=board.revision
    )


@router.delete("/{board_id}/widgets/{widget_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_board_widget(
    board_id: UUID,
    widget_id: UUID,
    revision: Annotated[int, Query(ge=1)],
    user: Reader,
    db: Database,
) -> Response:
    board = _board_with_access(db, user, board_id, AccessLevel.MANAGE, lock=True)
    _editable(board, revision)
    widgets = _active_widgets(db, board.id, lock=True)
    widget = next((item for item in widgets if item.id == widget_id), None)
    if widget is None:
        raise _not_found()
    db.delete(widget)
    for position, remaining in enumerate(item for item in widgets if item.id != widget_id):
        remaining.position = position
    board.revision += 1
    _commit(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
