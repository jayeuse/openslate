"""Board structure export, and import or duplicate into a new project Board."""

import json
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Response, status
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user, require_admin
from app.common.dependencies.auth import (
    CurrentIdentity,
    get_current_identity,
    require_fresh_exact_admin,
)
from app.core.database import get_db
from app.systems.access.policy.checks import (
    require_fresh_module_access,
    require_live_session,
    require_module_access,
)
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.models import Board, BoardScope, BoardStatus, BoardWidget
from app.systems.boards.portability import (
    MAX_PORTABLE_BOARD_BYTES,
    PortabilityError,
    ResolvedBoardConfiguration,
    parse_portable_board,
    resolve_portable_board,
)
from app.systems.boards.portability_queries import portable_config
from app.systems.boards.portability_schemas import (
    PortableBoardBundle,
    PortableBoardConfiguration,
    PortableWidget,
    PortableWidgetSource,
)
from app.systems.boards.router import _board_with_access
from app.systems.boards.router import _response as board_response
from app.systems.boards.schemas import BoardResponse
from app.systems.boards.widget_schemas import BoardInlineConfig, BoardWidgetConfig, BoardWidgetSpec
from app.systems.openview.charts.models import Chart
from app.systems.openview.charts.service import (
    read_chart,
    validate_query,
    widget_source_transaction,
)
from app.systems.openview.dashboards.schemas import (
    DashboardAggregateConfig,
    DashboardChartConfig,
    DashboardRecordsConfig,
    DashboardRecordsQuery,
)
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.query_schemas import GroupedAggregateSnapshotQuery


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(get_current_user)]
Admin = Annotated[User, Depends(require_admin)]
Database = Annotated[Session, Depends(get_db)]
Identity = Annotated[CurrentIdentity, Depends(get_current_identity)]


def _source_unavailable() -> PortabilityError:
    return PortabilityError("board_source_unavailable")


def _http_error(error: PortabilityError) -> HTTPException:
    if error.code == "board_bundle_too_large":
        return HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail={"code": error.code, "message": "Board configuration is too large"},
            headers={"Cache-Control": "private, no-store"},
        )
    if error.code == "board_bundle_invalid":
        return HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": error.code,
                "message": error.message or "Board configuration is invalid",
            },
            headers={"Cache-Control": "private, no-store"},
        )
    return HTTPException(
        status.HTTP_409_CONFLICT,
        detail={"code": error.code, "message": "A Board source is unavailable"},
        headers={"Cache-Control": "private, no-store"},
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
        .with_for_update(nowait=True)
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
        .with_for_update(nowait=True)
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
        .with_for_update(nowait=True)
        .execution_options(populate_existing=True)
    ).all()
    found = {row.id: row for row in rows if _active(row)}
    if set(found) != ids or len(rows) != len(ids):
        raise _source_unavailable()
    return found


def _widget_state(widget: BoardWidget) -> tuple[object, ...]:
    return (
        widget.id,
        widget.position,
        widget.name,
        widget.widget_type,
        widget.module_id,
        widget.chart_id,
        widget.size,
        widget.pinned,
        widget.updated_at,
        json.dumps(widget.config, sort_keys=True, separators=(",", ":")),
    )


def _inline_chart(spec: BoardWidgetSpec, chart: Chart) -> BoardWidgetSpec:
    category = "chart" if chart.chart_type in {"bar", "line", "pie"} else chart.chart_type
    if category != spec.widget_type or chart.module_id != spec.module_id:
        raise _source_unavailable()
    document: dict[str, object] = {"version": 1, "query": chart.query}
    if category == "chart":
        document["chart_type"] = chart.chart_type
        config: BoardInlineConfig = DashboardChartConfig.model_validate(document)
    elif category == "records":
        config = DashboardRecordsConfig.model_validate(document)
    else:
        config = DashboardAggregateConfig.model_validate(document)
    return BoardWidgetSpec.model_validate({**spec.model_dump(), "chart_id": None, "config": config})


def _field_ids(config: BoardInlineConfig) -> set[UUID]:
    if isinstance(config, BoardWidgetConfig):
        refs = [*config.fields, *config.filters, *((config.metric,) if config.metric else ())]
    else:
        query = config.query
        definition = query.definition
        refs = [
            *definition.columns,
            *definition.filters,
            *definition.sort,
            *definition.search_fields,
        ]
        if not isinstance(query, DashboardRecordsQuery):
            refs.extend(ref for ref in (query.measure, query.date_field) if ref is not None)
            if isinstance(query, GroupedAggregateSnapshotQuery):
                refs.append(query.dimension)
    return {ref.field_id for ref in refs}


def _bundle_from_board(
    db: Session, board_id: UUID, actor: User, identity: CurrentIdentity, *, mutation: bool
) -> tuple[PortableBoardBundle, ResolvedBoardConfiguration]:
    board = _board_with_access(db, actor, board_id, AccessLevel.MANAGE)
    board_state = (board.name, board.description, board.revision, board.updated_at)
    statement = (
        select(BoardWidget)
        .where(
            BoardWidget.board_id == board.id,
            BoardWidget.is_deleted.is_(False),
            BoardWidget.deleted_at.is_(None),
        )
        .order_by(BoardWidget.position, BoardWidget.id)
    )
    widgets = db.scalars(statement).all()
    before = [_widget_state(widget) for widget in widgets]
    if len(widgets) > 12:
        raise _source_unavailable()
    try:
        specs = [
            BoardWidgetSpec.model_validate(
                {
                    "name": widget.name,
                    "widget_type": widget.widget_type,
                    "module_id": widget.module_id,
                    "chart_id": widget.chart_id,
                    "config": widget.config,
                    "size": widget.size,
                    "pinned": widget.pinned,
                }
            )
            for widget in widgets
        ]
        chart_ids = {spec.chart_id for spec in specs if spec.chart_id is not None}
        discovered = {key: read_chart(db, actor, key) for key in sorted(chart_ids)}
        read_ids = {
            spec.module_id for spec in specs if not isinstance(spec.config, BoardWidgetConfig)
        } | {chart.module_id for chart in discovered.values()}
        for module_id in sorted(read_ids):
            require_module_access(db, actor, module_id, AccessLevel.READ)
            actor = require_fresh_module_access(
                db,
                actor_id=actor.id,
                session_id=identity.session_id,
                module_id=module_id,
                level=AccessLevel.READ,
            )
        if mutation:
            if read_ids:
                require_admin(actor)
            else:
                actor = require_fresh_exact_admin(db, actor.id)
                require_live_session(db, actor_id=actor.id, session_id=identity.session_id)
        module_ids = {spec.module_id for spec in specs} | read_ids
        discovered_departments = {
            row.id: row.department_id
            for row in db.scalars(select(Module).where(Module.id.in_(sorted(module_ids)))).all()
        }
        if discovered_departments.keys() != module_ids:
            raise _source_unavailable()
        departments = _locked_departments(db, set(discovered_departments.values()))
        modules = _locked_modules(db, module_ids)
        if any(
            modules[key].department_id != value for key, value in discovered_departments.items()
        ):
            raise _source_unavailable()
        charts = (
            {
                row.id: row
                for row in db.scalars(
                    select(Chart)
                    .where(Chart.id.in_(sorted(chart_ids)))
                    .order_by(Chart.id)
                    .with_for_update(nowait=True)
                    .execution_options(populate_existing=True)
                ).all()
            }
            if chart_ids
            else {}
        )
        if charts.keys() != chart_ids or any(
            row.is_deleted
            or row.deleted_at is not None
            or row.module_id not in modules
            or row.department_id != modules[row.module_id].department_id
            for row in charts.values()
        ):
            raise _source_unavailable()
        inline = [
            _inline_chart(spec, charts[spec.chart_id]) if spec.chart_id is not None else spec
            for spec in specs
        ]
        configs = [spec.config for spec in inline]
        if any(config is None for config in configs):
            raise _source_unavailable()
        fields = _locked_fields(
            db, {key for config in configs if config for key in _field_ids(config)}
        )
        portable_widgets: list[PortableWidget] = []
        for spec in inline:
            config = spec.config
            assert config is not None
            if not isinstance(config, BoardWidgetConfig):
                kind = (
                    config.chart_type
                    if isinstance(config, DashboardChartConfig)
                    else spec.widget_type
                )
                validate_query(
                    db, actor, spec.module_id, kind, config.query.model_dump(mode="json")
                )
            module = modules[spec.module_id]
            portable_widgets.append(
                PortableWidget(
                    name=spec.name,
                    widget_type=spec.widget_type,
                    source=PortableWidgetSource(
                        department_name=departments[module.department_id].department_name,
                        module_name=module.module_name,
                    ),
                    config=portable_config(config, module.id, fields, spec.size, spec.pinned),
                )
            )
        bundle = PortableBoardBundle(
            kind="openslate-board",
            version=3,
            configuration=PortableBoardConfiguration(
                name=board.name,
                description=board.description,
                widgets=portable_widgets,
            ),
        )
        if len(bundle.model_dump_json().encode()) > MAX_PORTABLE_BOARD_BYTES:
            raise PortabilityError("board_bundle_too_large")
        resolved = resolve_portable_board(db, bundle)
        for mapped, original in zip(resolved.widgets, inline, strict=True):
            assert mapped.config is not None and original.config is not None
            if mapped.model_dump(mode="json", exclude={"config"}) != original.model_dump(
                mode="json", exclude={"config"}
            ) or mapped.config.model_dump(
                mode="json", exclude={"refresh"}
            ) != original.config.model_dump(mode="json", exclude={"refresh"}):
                raise _source_unavailable()
    except ValidationError as error:
        raise _source_unavailable() from error
    except HTTPException as error:
        if error.status_code in {403, 404, 409, 422}:
            raise _source_unavailable() from error
        raise
    # Every source is fixed before the consumer lock; contention never waits or retries.
    db.scalar(
        select(Board)
        .where(Board.id == board_id)
        .with_for_update(nowait=True)
        .execution_options(populate_existing=True)
    )
    board = _board_with_access(db, actor, board_id, AccessLevel.MANAGE)
    current = db.scalars(
        statement.with_for_update(nowait=True).execution_options(populate_existing=True)
    ).all()
    if board_state != (
        board.name,
        board.description,
        board.revision,
        board.updated_at,
    ) or before != [_widget_state(widget) for widget in current]:
        raise _source_unavailable()
    return bundle, resolved


def _create_project_board(db: Session, resolved: ResolvedBoardConfiguration) -> Board:
    board = Board(
        scope=BoardScope.PROJECT.value,
        name=resolved.board.name,
        description=resolved.board.description,
        status=BoardStatus.ACTIVE,
    )
    try:
        db.add(board)
        db.flush()
        for position, spec in enumerate(resolved.widgets):
            db.add(
                BoardWidget(
                    board_id=board.id,
                    position=position,
                    name=spec.name,
                    widget_type=spec.widget_type,
                    module_id=spec.module_id,
                    config=spec.config.model_dump(mode="json", exclude={"refresh"})
                    if spec.config
                    else None,
                    chart_id=None,
                    size=spec.size,
                    pinned=spec.pinned,
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
    board_id: UUID, actor: Reader, identity: Identity, db: Database, response: Response
) -> PortableBoardBundle:
    with widget_source_transaction(db):
        try:
            bundle, _ = _bundle_from_board(db, board_id, actor, identity, mutation=False)
        except PortabilityError as error:
            raise _http_error(error) from error
    response.headers["Content-Disposition"] = 'attachment; filename="board-configuration.json"'
    return bundle


@router.post("/import", response_model=BoardResponse, status_code=status.HTTP_201_CREATED)
def import_board_configuration(
    raw: Annotated[bytes, Body(media_type="application/octet-stream")],
    actor: Admin,
    db: Database,
    response: Response,
) -> BoardResponse:
    with widget_source_transaction(db):
        try:
            bundle = parse_portable_board(raw)
            actor = require_fresh_exact_admin(db, actor.id)
            board = _create_project_board(db, resolve_portable_board(db, bundle))
        except PortabilityError as error:
            raise _http_error(error) from error
    response.headers["Location"] = f"/api/boards/{board.id}"
    return board_response(db, actor, board)


@router.post(
    "/{board_id}/duplicate", response_model=BoardResponse, status_code=status.HTTP_201_CREATED
)
def duplicate_board(
    board_id: UUID, actor: Admin, identity: Identity, db: Database, response: Response
) -> BoardResponse:
    with widget_source_transaction(db):
        try:
            bundle, resolved = _bundle_from_board(db, board_id, actor, identity, mutation=True)
            resolved.board.name = f"{bundle.configuration.name[:193]} (copy)"
            board = _create_project_board(db, resolved)
        except PortabilityError as error:
            raise _http_error(error) from error
    response.headers["Location"] = f"/api/boards/{board.id}"
    return board_response(db, actor, board)
