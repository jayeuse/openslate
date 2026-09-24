"""Board-scoped widget routes; not mounted until Board integration is ready."""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import ValidationError
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_capability
from app.common.listing import ListQuerySpec, execute_standard_list
from app.core.database import get_db
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.access.users.permissions import Capability
from app.systems.boards.models import Board, BoardPermission, BoardStatus, BoardWidget
from app.systems.boards.router import _board_with_access
from app.systems.boards.widget_schemas import (
    BoardWidgetAudience,
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
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.query import validate_definition
from app.systems.sandbox.records.query_schemas import QueryDefinition


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(require_capability(Capability.RECORDS_READ))]
Writer = Annotated[User, Depends(require_capability(Capability.RECORDS_WRITE))]
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


def _audience(widget: BoardWidget) -> BoardWidgetAudience:
    try:
        return BoardWidgetAudience(
            kind=widget.audience_kind,
            role_id=widget.audience_role_id,
            user_id=widget.audience_user_id,
        )
    except ValidationError:
        raise _not_found() from None


def _visible(widget: BoardWidget, actor: User) -> bool:
    audience = _audience(widget)
    if audience.kind == "everyone":
        return True
    if audience.kind == "private":
        return widget.creator_id == actor.id
    if audience.kind == "role":
        return audience.role_id == actor.role_id
    return audience.user_id == actor.id


def _visible_clause(actor: User) -> ColumnElement[bool]:
    """Apply widget audience before count and pagination, including for managers."""
    return or_(
        and_(
            BoardWidget.audience_kind == "everyone",
            BoardWidget.audience_role_id.is_(None),
            BoardWidget.audience_user_id.is_(None),
        ),
        and_(
            BoardWidget.audience_kind == "private",
            BoardWidget.creator_id == actor.id,
            BoardWidget.audience_role_id.is_(None),
            BoardWidget.audience_user_id.is_(None),
        ),
        and_(
            BoardWidget.audience_kind == "role",
            BoardWidget.audience_role_id == actor.role_id,
            BoardWidget.audience_user_id.is_(None),
        ),
        and_(
            BoardWidget.audience_kind == "user",
            BoardWidget.audience_user_id == actor.id,
            BoardWidget.audience_role_id.is_(None),
        ),
    )


def _active_widgets(db: Session, board_id: UUID, *, lock: bool = False) -> list[BoardWidget]:
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
        statement = statement.with_for_update().execution_options(populate_existing=True)
    return list(db.scalars(statement).all())


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
                "config": BoardWidgetConfig.model_validate(widget.config),
                "audience": _audience(widget),
                "created_at": widget.created_at,
                "updated_at": widget.updated_at,
            }
        )
    except ValidationError:
        raise _not_found() from None


def _validate_source(db: Session, widget: BoardWidgetSpec) -> None:
    module = db.scalar(
        select(Module.id)
        .where(
            Module.id == widget.module_id,
            Module.is_deleted.is_(False),
            Module.deleted_at.is_(None),
            Module.is_schema_accepted.is_(True),
        )
        .with_for_update()
    )
    if module is None:
        raise _conflict("widget_invalid", "The selected module or fields are unavailable")
    config = widget.config
    definition = QueryDefinition(columns=config.fields, filters=config.filters, logic=config.logic)
    try:
        fields = validate_definition(
            db,
            widget.module_id,
            definition,
            extra_references=(config.metric,) if config.metric is not None else (),
        )
    except HTTPException as error:
        if error.status_code == status.HTTP_409_CONFLICT:
            raise _conflict(
                "widget_invalid", "The selected module or fields are unavailable"
            ) from error
        raise
    referenced_ids = {
        reference.field_id
        for reference in (
            *config.fields,
            *config.filters,
            *((config.metric,) if config.metric else ()),
        )
    }
    if any(
        fields[field_id].is_deleted or fields[field_id].deleted_at is not None
        for field_id in referenced_ids
    ):
        raise _conflict("widget_invalid", "The selected module or fields are unavailable")


def _validate_audience(db: Session, audience: BoardWidgetAudience) -> None:
    if audience.kind == "role":
        valid = db.scalar(
            select(Role.id)
            .where(
                Role.id == audience.role_id,
                Role.is_deleted.is_(False),
                Role.deleted_at.is_(None),
            )
            .with_for_update()
        )
    elif audience.kind == "user":
        valid = db.scalar(
            select(User.id)
            .join(Role, Role.id == User.role_id)
            .where(
                User.id == audience.user_id,
                User.status == UserStatus.ACTIVE.value,
                User.is_deleted.is_(False),
                User.deleted_at.is_(None),
                established_user_clause(),
                Role.is_deleted.is_(False),
                Role.deleted_at.is_(None),
            )
            .with_for_update()
        )
    else:
        return
    if valid is None:
        raise _conflict("audience_invalid", "The selected audience is unavailable")


def _write(widget: BoardWidget, payload: BoardWidgetSpec) -> None:
    widget.name = payload.name
    widget.widget_type = payload.widget_type
    widget.module_id = payload.module_id
    widget.config = payload.config.model_dump(mode="json")
    widget.audience_kind = payload.audience.kind
    widget.audience_role_id = payload.audience.role_id
    widget.audience_user_id = payload.audience.user_id


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
    board = _board_with_access(db, user, board_id, BoardPermission.VIEW)
    result = execute_standard_list(
        db,
        select(BoardWidget).where(
            BoardWidget.board_id == board.id,
            BoardWidget.is_deleted.is_(False),
            BoardWidget.deleted_at.is_(None),
            _visible_clause(user),
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
    board_id: UUID, payload: BoardWidgetWrite, user: Writer, db: Database, response: Response
) -> BoardWidgetMutationResponse:
    board = _board_with_access(db, user, board_id, BoardPermission.EDIT, lock=True)
    _editable(board, payload.revision)
    widgets = _active_widgets(db, board.id, lock=True)
    if len(widgets) >= 12:
        raise _conflict("widget_limit", "A Board can contain at most 12 widgets")
    _validate_source(db, payload.widget)
    _validate_audience(db, payload.widget.audience)
    widget = BoardWidget(
        board_id=board.id,
        creator_id=user.id,
        position=len(widgets),
        name=payload.widget.name,
        widget_type=payload.widget.widget_type,
        module_id=payload.widget.module_id,
        config=payload.widget.config.model_dump(mode="json"),
        audience_kind=payload.widget.audience.kind,
        audience_role_id=payload.widget.audience.role_id,
        audience_user_id=payload.widget.audience.user_id,
    )
    db.add(widget)
    board.revision += 1
    _commit(db)
    db.refresh(widget)
    response.headers["Location"] = f"/api/boards/{board.id}/widgets/{widget.id}"
    return BoardWidgetMutationResponse(widget=_response(widget), board_revision=board.revision)


@router.patch("/{board_id}/widgets/{widget_id}", response_model=BoardWidgetMutationResponse)
def update_board_widget(
    board_id: UUID, widget_id: UUID, payload: BoardWidgetWrite, user: Writer, db: Database
) -> BoardWidgetMutationResponse:
    board = _board_with_access(db, user, board_id, BoardPermission.EDIT, lock=True)
    _editable(board, payload.revision)
    widget = next(
        (item for item in _active_widgets(db, board.id, lock=True) if item.id == widget_id), None
    )
    if widget is None or not _visible(widget, user):
        raise _not_found()
    _validate_source(db, payload.widget)
    _validate_audience(db, payload.widget.audience)
    if widget.audience_kind != "private" and payload.widget.audience.kind == "private":
        widget.creator_id = user.id
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
    user: Writer,
    db: Database,
    response: Response,
) -> BoardWidgetMutationResponse:
    board = _board_with_access(db, user, board_id, BoardPermission.EDIT, lock=True)
    _editable(board, payload.revision)
    widgets = _active_widgets(db, board.id, lock=True)
    source = next((item for item in widgets if item.id == widget_id), None)
    if source is None or not _visible(source, user):
        raise _not_found()
    if len(widgets) >= 12:
        raise _conflict("widget_limit", "A Board can contain at most 12 widgets")
    source_spec = BoardWidgetSpec.model_validate(
        {
            "name": source.name,
            "widget_type": source.widget_type,
            "module_id": source.module_id,
            "config": source.config,
            "audience": _audience(source),
        }
    )
    _validate_source(db, source_spec)
    _validate_audience(db, source_spec.audience)
    duplicate = BoardWidget(
        board_id=board.id,
        creator_id=user.id,
        position=len(widgets),
        name=source.name,
        widget_type=source.widget_type,
        module_id=source.module_id,
        config=dict(source.config),
        audience_kind=source.audience_kind,
        audience_role_id=source.audience_role_id,
        audience_user_id=source.audience_user_id,
    )
    db.add(duplicate)
    board.revision += 1
    _commit(db)
    db.refresh(duplicate)
    response.headers["Location"] = f"/api/boards/{board.id}/widgets/{duplicate.id}"
    return BoardWidgetMutationResponse(widget=_response(duplicate), board_revision=board.revision)


@router.put("/{board_id}/widgets/order", response_model=BoardWidgetOrderResponse)
def reorder_board_widgets(
    board_id: UUID, payload: BoardWidgetOrder, user: Writer, db: Database
) -> BoardWidgetOrderResponse:
    board = _board_with_access(db, user, board_id, BoardPermission.EDIT, lock=True)
    _editable(board, payload.revision)
    visible = [item for item in _active_widgets(db, board.id, lock=True) if _visible(item, user)]
    if set(payload.widget_ids) != {item.id for item in visible}:
        raise _conflict("widget_order_invalid", "Order must contain the visible Board widgets")
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
    user: Writer,
    db: Database,
) -> Response:
    board = _board_with_access(db, user, board_id, BoardPermission.EDIT, lock=True)
    _editable(board, revision)
    widgets = _active_widgets(db, board.id, lock=True)
    widget = next((item for item in widgets if item.id == widget_id), None)
    if widget is None or not _visible(widget, user):
        raise _not_found()
    db.delete(widget)
    for position, remaining in enumerate(item for item in widgets if item.id != widget_id):
        remaining.position = position
    board.revision += 1
    _commit(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
