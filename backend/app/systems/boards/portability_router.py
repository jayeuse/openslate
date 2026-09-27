"""Board structure export, import and duplicate routes; not mounted in the application yet."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Response, status
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies import require_legacy_capability
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.access.users.permissions import Capability
from app.systems.boards.access import can_read_board_grants
from app.systems.boards.models import Board, BoardGrant, BoardPermission, BoardStatus, BoardWidget
from app.systems.boards.portability import (
    MAX_PORTABLE_BOARD_BYTES,
    PortabilityError,
    parse_portable_board,
    resolve_portable_board,
)
from app.systems.boards.portability_schemas import (
    PortableBoardBundle,
    PortableBoardConfiguration,
    PortableFieldReference,
    PortableQueryFilter,
    PortableWidget,
    PortableWidgetConfig,
    PortableWidgetSource,
)
from app.systems.boards.router import _board_with_access
from app.systems.boards.schemas import BoardResponse
from app.systems.boards.widget_router import _visible_clause
from app.systems.boards.widget_schemas import BoardWidgetConfig
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_READ))]
Writer = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_WRITE))]
Database = Annotated[Session, Depends(get_db)]


def _source_unavailable() -> PortabilityError:
    return PortabilityError("board_source_unavailable")


def _http_error(error: PortabilityError) -> HTTPException:
    if error.code == "board_bundle_too_large":
        return HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail={"code": error.code, "message": "Board configuration is too large"},
        )
    if error.code == "board_bundle_invalid":
        return HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": error.code, "message": "Board configuration is invalid"},
        )
    return HTTPException(
        status.HTTP_409_CONFLICT,
        detail={"code": error.code, "message": "A Board source is unavailable"},
    )


def _active(row: Department | Module | Field) -> bool:
    return not row.is_deleted and row.deleted_at is None


def _locked_departments(db: Session, ids: set[UUID]) -> dict[UUID, Department]:
    if not ids:
        return {}
    rows = db.scalars(
        select(Department)
        .where(
            Department.id.in_(sorted(ids)),
            Department.is_deleted.is_(False),
            Department.deleted_at.is_(None),
        )
        .order_by(Department.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).all()
    found = {row.id: row for row in rows if _active(row)}
    if set(found) != ids or len(rows) != len(ids):
        raise _source_unavailable()
    return found


def _locked_modules(db: Session, ids: set[UUID]) -> dict[UUID, Module]:
    if not ids:
        return {}
    rows = db.scalars(
        select(Module)
        .where(
            Module.id.in_(sorted(ids)),
            Module.is_deleted.is_(False),
            Module.deleted_at.is_(None),
        )
        .order_by(Module.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).all()
    found = {row.id: row for row in rows if _active(row)}
    if set(found) != ids or len(rows) != len(ids):
        raise _source_unavailable()
    return found


def _locked_fields(db: Session, ids: set[UUID]) -> dict[UUID, Field]:
    if not ids:
        return {}
    rows = db.scalars(
        select(Field)
        .where(Field.id.in_(sorted(ids)), Field.is_deleted.is_(False), Field.deleted_at.is_(None))
        .order_by(Field.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).all()
    found = {row.id: row for row in rows if _active(row)}
    if set(found) != ids or len(rows) != len(ids):
        raise _source_unavailable()
    return found


def _portable_field(
    reference_id: UUID, expected_type: str, module_id: UUID, fields: dict[UUID, Field]
) -> PortableFieldReference:
    field = fields.get(reference_id)
    if field is None or field.module_id != module_id or field.type != expected_type:
        raise _source_unavailable()
    return PortableFieldReference(name=field.name, expected_type=field.type)


def _read_managed_board(db: Session, board_id: UUID, actor: User) -> Board:
    board = db.scalar(
        select(Board)
        .where(Board.id == board_id, Board.is_deleted.is_(False), Board.deleted_at.is_(None))
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if board is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Board not found")
    grants = db.scalars(
        select(BoardGrant).where(
            BoardGrant.board_id == board.id,
            BoardGrant.is_deleted.is_(False),
            BoardGrant.deleted_at.is_(None),
        )
    ).all()
    if not can_read_board_grants(board, actor, grants):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Board not found")
    return board


def _bundle_from_board(
    db: Session, board_id: UUID, actor: User, *, mutation: bool
) -> PortableBoardBundle:
    board = (
        _board_with_access(db, actor, board_id, BoardPermission.MANAGE, lock=True)
        if mutation
        else _read_managed_board(db, board_id, actor)
    )
    widgets = db.scalars(
        select(BoardWidget)
        .where(
            BoardWidget.board_id == board.id,
            BoardWidget.is_deleted.is_(False),
            BoardWidget.deleted_at.is_(None),
            _visible_clause(actor),
        )
        .order_by(BoardWidget.position, BoardWidget.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).all()
    if len(widgets) > 12:
        raise _source_unavailable()

    try:
        configs = {widget.id: BoardWidgetConfig.model_validate(widget.config) for widget in widgets}
    except ValidationError as error:
        raise _source_unavailable() from error
    module_ids = {widget.module_id for widget in widgets}
    # Read IDs without locks only to discover departments; locked rows are rechecked below.
    candidates = db.scalars(select(Module).where(Module.id.in_(sorted(module_ids)))).all()
    if {module.id for module in candidates} != module_ids:
        raise _source_unavailable()
    department_ids = {module.department_id for module in candidates}
    if board.department_id is not None:
        department_ids.add(board.department_id)
    departments = _locked_departments(db, department_ids)
    modules = _locked_modules(db, module_ids)
    if any(modules[module.id].department_id != module.department_id for module in candidates):
        raise _source_unavailable()

    field_ids = {
        reference.field_id
        for config in configs.values()
        for reference in (
            *config.fields,
            *config.filters,
            *((config.metric,) if config.metric else ()),
        )
    }
    fields = _locked_fields(db, field_ids)
    try:
        portable_widgets: list[PortableWidget] = []
        for widget in widgets:
            module = modules[widget.module_id]
            config = configs[widget.id]
            portable_widgets.append(
                PortableWidget(
                    name=widget.name,
                    widget_type=widget.widget_type,
                    source=PortableWidgetSource(
                        department_name=departments[module.department_id].department_name,
                        module_name=module.module_name,
                    ),
                    config=PortableWidgetConfig(
                        fields=[
                            _portable_field(ref.field_id, ref.expected_type, module.id, fields)
                            for ref in config.fields
                        ],
                        filters=[
                            PortableQueryFilter(
                                **_portable_field(
                                    ref.field_id, ref.expected_type, module.id, fields
                                ).model_dump(),
                                operator=ref.operator,
                                value=ref.value,
                            )
                            for ref in config.filters
                        ],
                        logic=config.logic,
                        metric=(
                            _portable_field(
                                config.metric.field_id,
                                config.metric.expected_type,
                                module.id,
                                fields,
                            )
                            if config.metric is not None
                            else None
                        ),
                        visualization=config.visualization,
                        size=config.size,
                        refresh=config.refresh,
                        pinned=config.pinned,
                    ),
                )
            )
        bundle = PortableBoardBundle(
            kind="openslate-board",
            version=2,
            configuration=PortableBoardConfiguration(
                name=board.name,
                description=board.description,
                department_name=(
                    departments[board.department_id].department_name
                    if board.department_id is not None
                    else None
                ),
                default_section=board.default_section,
                widgets=portable_widgets,
            ),
        )
    except (ValidationError, KeyError) as error:
        raise _source_unavailable() from error
    if len(bundle.model_dump_json().encode()) > MAX_PORTABLE_BOARD_BYTES:
        raise PortabilityError("board_bundle_too_large")
    resolved = resolve_portable_board(db, bundle)
    if resolved.board.department_id != board.department_id or any(
        mapped.module_id != original.module_id
        or mapped.config.model_dump(mode="json") != configs[original.id].model_dump(mode="json")
        for mapped, original in zip(resolved.widgets, widgets, strict=True)
    ):
        raise _source_unavailable()
    return bundle


def _create_private_board(db: Session, actor: User, bundle: PortableBoardBundle) -> Board:
    resolved = resolve_portable_board(db, bundle)
    board = Board(
        owner_id=actor.id,
        department_id=resolved.board.department_id,
        name=resolved.board.name,
        description=resolved.board.description,
        status=BoardStatus.ACTIVE,
        default_section=resolved.board.default_section,
    )
    try:
        db.add(board)
        db.flush()
        for position, spec in enumerate(resolved.widgets):
            db.add(
                BoardWidget(
                    board_id=board.id,
                    creator_id=actor.id,
                    position=position,
                    name=spec.name,
                    widget_type=spec.widget_type,
                    module_id=spec.module_id,
                    config=spec.config.model_dump(mode="json"),
                    audience_kind="everyone",
                )
            )
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"code": "board_import_conflict", "message": "Unable to create Board"},
        ) from error
    except SQLAlchemyError:
        db.rollback()
        raise
    db.refresh(board)
    return board


@router.get("/{board_id}/configuration", response_model=PortableBoardBundle)
def export_board_configuration(
    board_id: UUID, actor: Reader, db: Database, response: Response
) -> PortableBoardBundle:
    try:
        bundle = _bundle_from_board(db, board_id, actor, mutation=False)
    except PortabilityError as error:
        db.rollback()
        raise _http_error(error) from error
    response.headers["Content-Disposition"] = 'attachment; filename="board-configuration.json"'
    return bundle


@router.post("/import", response_model=BoardResponse, status_code=status.HTTP_201_CREATED)
def import_board_configuration(
    raw: Annotated[bytes, Body(media_type="application/octet-stream")],
    actor: Writer,
    db: Database,
    response: Response,
) -> BoardResponse:
    try:
        bundle = parse_portable_board(raw)
        board = _create_private_board(db, actor, bundle)
    except PortabilityError as error:
        db.rollback()
        raise _http_error(error) from error
    response.headers["Location"] = f"/api/boards/{board.id}"
    return BoardResponse.model_validate(board)


@router.post(
    "/{board_id}/duplicate", response_model=BoardResponse, status_code=status.HTTP_201_CREATED
)
def duplicate_board(
    board_id: UUID, actor: Reader, _: Writer, db: Database, response: Response
) -> BoardResponse:
    try:
        bundle = _bundle_from_board(db, board_id, actor, mutation=True)
        bundle.configuration.name = f"{bundle.configuration.name[:193]} (copy)"
        board = _create_private_board(db, actor, bundle)
    except PortabilityError as error:
        db.rollback()
        raise _http_error(error) from error
    response.headers["Location"] = f"/api/boards/{board.id}"
    return BoardResponse.model_validate(board)
