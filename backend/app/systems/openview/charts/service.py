"""Current source authority, field validation and retained Chart-consumer coordination."""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, cast
from uuid import UUID

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import Select, exists, func, literal, select, union
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Bundle, Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies.auth import CurrentIdentity, get_current_user
from app.common.listing import ListQuerySpec, execute_standard_list
from app.systems.access.policy.checks import (
    department_filter,
    forbidden,
    module_filter,
    require_fresh_module_access,
    require_module_access,
)
from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.scope import effective_levels
from app.systems.access.users.models import User
from app.systems.boards.access import visible_board_clause
from app.systems.boards.models import Board, BoardWidget
from app.systems.openview.charts.models import Chart
from app.systems.openview.charts.schemas import (
    ChartDefinition,
    ChartQuery,
    ChartResponse,
    ChartUsageItem,
    ChartUsageRequest,
    ChartUsageResponse,
    ChartUsageSort,
)
from app.systems.openview.dashboards.models import Dashboard, DashboardWidget
from app.systems.openview.dashboards.schemas import DashboardRecordsQuery
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.query import validate_definition
from app.systems.sandbox.records.query_schemas import DateSeriesAggregateQuery, FieldReference

CACHE = {"Cache-Control": "private, no-store"}


def conflict(code: str, message: str, **extra: object) -> HTTPException:
    return HTTPException(409, detail={"code": code, "message": message, **extra}, headers=CACHE)


def invalid_chart() -> HTTPException:
    return conflict("chart_invalid", "The Chart source, type or selected fields are unavailable")


def read_chart(db: Session, actor: User, chart_id: UUID) -> Chart:
    chart = db.scalar(
        select(Chart).where(
            Chart.id == chart_id, module_filter(db, actor, AccessLevel.READ, Chart.module_id)
        )
    )
    if chart is None:
        raise HTTPException(404, detail="Chart not found", headers=CACHE)
    return chart


def locked_source(
    db: Session,
    identity: CurrentIdentity,
    module_id: UUID,
    *,
    active: bool = True,
) -> tuple[Module, User]:
    user = get_current_user(identity)
    require_module_access(db, user, module_id, AccessLevel.READ)
    # Group/access/user/session locks must precede source locks: access writers
    # lock group then department/module, and publication locks group, then module
    # access rows, then department/module.
    actor = require_fresh_module_access(
        db,
        actor_id=user.id,
        session_id=identity.session_id,
        module_id=module_id,
        level=AccessLevel.READ,
    )
    source = db.scalar(select(Module).where(Module.id == module_id))
    if source is None:
        raise invalid_chart()
    department_id = source.department_id
    department_statement = select(Department).where(Department.id == department_id)
    source_statement = select(Module).where(Module.id == module_id)
    if active:
        department_statement = department_statement.where(
            Department.is_deleted.is_(False),
            Department.deleted_at.is_(None),
        )
        source_statement = source_statement.where(
            Module.is_deleted.is_(False),
            Module.deleted_at.is_(None),
        )
    department = db.scalar(department_statement.with_for_update(read=True))
    source = db.scalar(
        source_statement.with_for_update(read=True).execution_options(populate_existing=True)
    )
    if department is None or source is None or source.department_id != department_id:
        raise invalid_chart()
    require_module_access(db, actor, source.id, AccessLevel.READ)
    if effective_levels(db, actor).department_level(source.department_id) != AccessLevel.MANAGE:
        raise forbidden()
    return source, actor


def locked_chart(
    db: Session,
    identity: CurrentIdentity,
    chart_id: UUID,
    *,
    active: bool = True,
) -> tuple[Chart, Module, User]:
    initial = read_chart(db, identity.user, chart_id)
    source, actor = locked_source(db, identity, initial.module_id, active=active)
    chart = db.scalar(
        select(Chart)
        .where(Chart.id == chart_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if chart is None:
        raise HTTPException(404, detail="Chart not found", headers=CACHE)
    if chart.module_id != source.id:
        raise invalid_chart()
    return chart, source, actor


def validate_query(
    db: Session,
    actor: User,
    module_id: UUID,
    chart_type: str,
    query: object,
) -> ChartQuery:
    try:
        definition = ChartDefinition.model_validate({"chart_type": chart_type, "query": query})
    except ValidationError:
        raise invalid_chart() from None
    parsed = definition.query
    if parsed.module_id != module_id:
        raise invalid_chart()
    additional: tuple[FieldReference | None, ...]
    if isinstance(parsed, DashboardRecordsQuery):
        additional = ()
    elif isinstance(parsed, DateSeriesAggregateQuery):
        additional = (parsed.date_field, parsed.measure)
    else:
        additional = (parsed.dimension, parsed.measure, parsed.date_field)
    refs = tuple(ref for ref in additional if ref is not None)
    try:
        fields = validate_definition(db, module_id, parsed.definition, refs, reader=actor)
    except HTTPException as error:
        if error.status_code == 409:
            raise invalid_chart() from error
        raise
    ids = {
        reference.field_id
        for reference in (
            *parsed.definition.columns,
            *parsed.definition.filters,
            *parsed.definition.sort,
            *parsed.definition.search_fields,
            *refs,
        )
    }
    if any(fields[key].is_deleted or fields[key].deleted_at is not None for key in ids):
        raise invalid_chart()
    return parsed


@contextmanager
def widget_source_transaction(db: Session) -> Iterator[None]:
    """Release all widget source/consumer locks on refusal; never retry busy writes."""
    try:
        yield
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            503, detail="Widget write is temporarily unavailable", headers=CACHE
        ) from error


def lock_widget_sources(
    db: Session,
    identity: CurrentIdentity,
    inline_module_ids: set[UUID],
    chart_ids: set[UUID],
) -> tuple[dict[UUID, Module], dict[UUID, Chart], User]:
    """Fresh READ authority, then ordered NOWAIT Department→Module→Chart locks.

    Callers discover consumers unlocked, then lock/recheck consumers and widgets
    with NOWAIT after this function. This avoids publication's Module→Board and
    Board group replacement's Board→Group edges. No consumer manage is inherited.
    """
    actor = get_current_user(identity)
    discovered = {chart_id: read_chart(db, actor, chart_id) for chart_id in sorted(chart_ids)}
    module_ids = inline_module_ids | {chart.module_id for chart in discovered.values()}
    for module_id in sorted(module_ids):
        require_module_access(db, actor, module_id, AccessLevel.READ)
        actor = require_fresh_module_access(
            db,
            actor_id=actor.id,
            session_id=identity.session_id,
            module_id=module_id,
            level=AccessLevel.READ,
        )
    candidates = {
        module.id: module
        for module in db.scalars(select(Module).where(Module.id.in_(module_ids))).all()
    }
    if candidates.keys() != module_ids:
        raise invalid_chart()
    discovered_departments = {key: value.department_id for key, value in candidates.items()}
    department_ids = set(discovered_departments.values())
    departments = {
        row.id: row
        for row in db.scalars(
            select(Department)
            .where(Department.id.in_(department_ids))
            .order_by(Department.id)
            .with_for_update(read=True, nowait=True)
            .execution_options(populate_existing=True)
        ).all()
    }
    if departments.keys() != department_ids or any(
        row.is_deleted or row.deleted_at is not None for row in departments.values()
    ):
        raise invalid_chart()
    modules: dict[UUID, Module] = {}
    for module_id in sorted(module_ids):
        module = db.scalar(
            select(Module)
            .where(Module.id == module_id)
            .with_for_update(read=module_id not in inline_module_ids, nowait=True)
            .execution_options(populate_existing=True)
        )
        if (
            module is None
            or module.is_deleted
            or module.deleted_at is not None
            or module.department_id != discovered_departments[module_id]
        ):
            raise invalid_chart()
        require_module_access(db, actor, module_id, AccessLevel.READ)
        modules[module_id] = module
    charts: dict[UUID, Chart] = {}
    for chart_id in sorted(chart_ids):
        expected_module = discovered[chart_id].module_id
        chart = db.scalar(
            select(Chart)
            .where(Chart.id == chart_id)
            .with_for_update(nowait=True)
            .execution_options(populate_existing=True)
        )
        if (
            chart is None
            or chart.is_deleted
            or chart.deleted_at is not None
            or chart.module_id != expected_module
        ):
            raise invalid_chart()
        validate_query(db, actor, chart.module_id, chart.chart_type, chart.query)
        charts[chart_id] = chart
    return modules, charts, actor


def response(chart: Chart) -> ChartResponse:
    try:
        return ChartResponse.model_validate(
            {
                "id": chart.id,
                "department_id": chart.department_id,
                "module_id": chart.module_id,
                "name": chart.name,
                "chart_type": chart.chart_type,
                "query": chart.query,
                "revision": chart.revision,
                "is_deleted": chart.is_deleted,
                "created_at": chart.created_at,
                "updated_at": chart.updated_at,
            }
        )
    except ValidationError:
        raise invalid_chart() from None


def in_use(db: Session, chart_id: UUID) -> bool:
    return bool(db.scalar(select(exists().where(BoardWidget.chart_id == chart_id)))) or bool(
        db.scalar(select(exists().where(DashboardWidget.chart_id == chart_id)))
    )


def incompatible_uses(db: Session, chart_id: UUID, chart_type: str) -> bool:
    category = chart_type if chart_type in {"summary", "workload", "records"} else "chart"
    return bool(
        db.scalar(
            select(
                exists().where(
                    BoardWidget.chart_id == chart_id,
                    BoardWidget.widget_type != category,
                )
            )
        )
    ) or bool(
        db.scalar(
            select(
                exists().where(
                    DashboardWidget.chart_id == chart_id,
                    DashboardWidget.widget_type != category,
                )
            )
        )
    )


def usage(
    db: Session,
    actor: User,
    chart_id: UUID,
    params: ChartUsageRequest,
) -> ChartUsageResponse:
    unrestricted = effective_levels(db, actor).unrestricted
    board_visible = (
        literal(True)
        if unrestricted
        else (
            visible_board_clause(actor) & Board.is_deleted.is_(False) & Board.deleted_at.is_(None)
        )
    )
    dashboard_visible = department_filter(db, actor, Dashboard.department_id)
    targets = union(
        select(
            literal("board").label("kind"),
            Board.id.label("id"),
            Board.name.label("name"),
            board_visible.label("visible"),
        )
        .join(BoardWidget, BoardWidget.board_id == Board.id)
        .where(BoardWidget.chart_id == chart_id),
        select(
            literal("dashboard").label("kind"),
            Dashboard.id.label("id"),
            Dashboard.name.label("name"),
            dashboard_visible.label("visible"),
        )
        .join(DashboardWidget, DashboardWidget.dashboard_id == Dashboard.id)
        .where(DashboardWidget.chart_id == chart_id),
    ).subquery()
    statement: Select[tuple[Any]] = select(
        Bundle("usage", targets.c.kind, targets.c.id, targets.c.name)
    ).where(targets.c.visible.is_(True))
    spec = ListQuerySpec(
        sort_fields={ChartUsageSort.NAME: cast(ColumnElement[Any], targets.c.name)},
        default_sort=ChartUsageSort.NAME,
        tie_breaker=func.row(targets.c.kind, targets.c.id),
        search_fields=(cast(ColumnElement[str], targets.c.name),),
    )
    listed = execute_standard_list(db, statement, params, spec)
    restricted = bool(db.scalar(select(exists().where(targets.c.visible.is_(False)))))
    return ChartUsageResponse(
        items=[ChartUsageItem(kind=row.kind, id=row.id, name=row.name) for row in listed.items],
        pagination=listed.pagination,
        has_restricted_usage=restricted,
    )
