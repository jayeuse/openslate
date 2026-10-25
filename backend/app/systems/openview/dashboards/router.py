"""Revisioned department Dashboards and their widgets on the 4 x 5 grid.

Every user who can read something in a department reads its Dashboards. Only a
user with ``manage`` on the department (or an administrator) changes them. One active
Dashboard per department is its home.
"""

from datetime import UTC, datetime
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user
from app.common.dependencies.auth import CurrentIdentity, get_current_identity
from app.common.listing import ListQuerySpec, StandardListResponse, execute_standard_list
from app.core.database import get_db
from app.systems.access.policy.checks import department_filter, forbidden
from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.scope import effective_levels
from app.systems.access.users.models import User
from app.systems.openview.charts import service as charts
from app.systems.openview.dashboards.models import Dashboard, DashboardWidget
from app.systems.openview.dashboards.schemas import (
    DashboardCreate,
    DashboardListRequest,
    DashboardResponse,
    DashboardRestore,
    DashboardSort,
    DashboardUpdate,
    DashboardWidgetResponse,
    DashboardWidgetSpec,
)
from app.systems.openview.dashboards.service import claim_home_if_missing, hand_over_home
from app.systems.openview.dashboards.widget_validation import validate_dashboard_widgets
from app.systems.sandbox.departments.models import Department


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(
    prefix="/dashboards",
    tags=["dashboards"],
    dependencies=[Depends(_private_cache)],
)
Reader = Annotated[User, Depends(get_current_user)]
# Changing a Dashboard needs ``manage`` on its department; each route checks it.
Writer = Annotated[User, Depends(get_current_user)]
SourceWriter = Annotated[CurrentIdentity, Depends(get_current_identity)]
Database = Annotated[Session, Depends(get_db)]

DASHBOARD_LIST_SPEC = ListQuerySpec(
    sort_fields={
        DashboardSort.POSITION: cast(ColumnElement[Any], Dashboard.position),
        DashboardSort.NAME: cast(ColumnElement[Any], Dashboard.name),
        DashboardSort.CREATED_AT: cast(ColumnElement[Any], Dashboard.created_at),
        DashboardSort.UPDATED_AT: cast(ColumnElement[Any], Dashboard.updated_at),
    },
    default_sort=DashboardSort.POSITION,
    tie_breaker=cast(ColumnElement[Any], Dashboard.id),
    search_fields=(cast(ColumnElement[str], Dashboard.name),),
    deleted_field=cast(ColumnElement[bool], Dashboard.is_deleted),
)


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail="Dashboard not found")


def _conflict(code: str, message: str, **extra: int) -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT,
        detail={"code": code, "message": message, **extra},
    )


def _invalid_dashboard() -> HTTPException:
    return _conflict("dashboard_invalid", "A widget references unavailable or changed fields")


def _stale_revision(current_revision: int) -> HTTPException:
    return _conflict(
        "stale_revision",
        "Dashboard changed; reload before saving",
        current_revision=current_revision,
    )


def _require_manager(db: Session, user: User, department_id: UUID) -> None:
    """404 when the user reads nothing in the department, 403 without ``manage``."""

    access = effective_levels(db, user)
    readable = access.department_ids()
    if readable is not None and department_id not in readable:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Department not found")
    if access.department_level(department_id) != AccessLevel.MANAGE:
        raise forbidden()


def _dashboard(
    db: Session,
    user: User,
    dashboard_id: UUID,
    *,
    lock: bool = False,
    manage: bool = False,
    nowait: bool = False,
) -> Dashboard:
    statement = select(Dashboard).where(
        Dashboard.id == dashboard_id,
        department_filter(db, user, Dashboard.department_id),
    )
    if lock:
        statement = statement.with_for_update(nowait=nowait).execution_options(
            populate_existing=True
        )
    dashboard = db.scalar(statement)
    if dashboard is None:
        raise _not_found()
    if manage:
        _require_manager(db, user, dashboard.department_id)
    return dashboard


def _widget_response(widget: DashboardWidget) -> DashboardWidgetResponse:
    return DashboardWidgetResponse(
        id=widget.id,
        position=widget.position,
        widget_type=widget.widget_type,
        grid_column=widget.grid_column,
        grid_row=widget.grid_row,
        column_span=widget.column_span,
        row_span=widget.row_span,
        config=widget.config,
        chart_id=widget.chart_id,
        created_at=widget.created_at,
        updated_at=widget.updated_at,
    )


def _dashboard_responses(db: Session, dashboards: list[Dashboard]) -> list[DashboardResponse]:
    if not dashboards:
        return []
    dashboard_ids = [dashboard.id for dashboard in dashboards]
    rows = db.scalars(
        select(DashboardWidget)
        .where(
            DashboardWidget.dashboard_id.in_(dashboard_ids),
            DashboardWidget.is_deleted.is_(False),
            DashboardWidget.deleted_at.is_(None),
        )
        .order_by(DashboardWidget.dashboard_id, DashboardWidget.position, DashboardWidget.id)
    ).all()
    grouped: dict[UUID, list[DashboardWidgetResponse]] = {item: [] for item in dashboard_ids}
    for widget in rows:
        grouped[widget.dashboard_id].append(_widget_response(widget))
    return [
        DashboardResponse(
            id=dashboard.id,
            department_id=dashboard.department_id,
            position=dashboard.position,
            name=dashboard.name,
            refresh_cadence=dashboard.refresh_cadence,
            revision=dashboard.revision,
            is_home=dashboard.is_home,
            is_deleted=dashboard.is_deleted,
            created_at=dashboard.created_at,
            updated_at=dashboard.updated_at,
            widgets=grouped[dashboard.id],
        )
        for dashboard in dashboards
    ]


def _dashboard_response(db: Session, dashboard: Dashboard) -> DashboardResponse:
    return _dashboard_responses(db, [dashboard])[0]


def _stored_config(widget: DashboardWidgetSpec) -> dict[str, Any] | None:
    return widget.config.model_dump(mode="json") if widget.config is not None else None


def _new_widget(
    dashboard: Dashboard, position: int, widget: DashboardWidgetSpec
) -> DashboardWidget:
    return DashboardWidget(
        org_id=dashboard.org_id,
        dashboard_id=dashboard.id,
        position=position,
        widget_type=widget.widget_type,
        config=_stored_config(widget),
        chart_id=widget.chart_id,
        grid_column=widget.grid_column,
        grid_row=widget.grid_row,
        column_span=widget.column_span,
        row_span=widget.row_span,
    )


def _widget_state(widget: DashboardWidget | DashboardWidgetSpec) -> tuple[object, ...]:
    config = (
        _stored_config(widget) if isinstance(widget, DashboardWidgetSpec) else widget.config
    )
    return (
        widget.widget_type,
        config,
        widget.chart_id,
        widget.grid_column,
        widget.grid_row,
        widget.column_span,
        widget.row_span,
    )


def _replace_widgets(
    db: Session,
    dashboard: Dashboard,
    widgets: list[DashboardWidgetSpec],
) -> bool:
    current = list(
        db.scalars(
            select(DashboardWidget)
            .where(
                DashboardWidget.dashboard_id == dashboard.id,
                DashboardWidget.is_deleted.is_(False),
                DashboardWidget.deleted_at.is_(None),
            )
            .order_by(DashboardWidget.position, DashboardWidget.id)
        ).all()
    )
    current_by_position = {widget.position: widget for widget in current}
    preserved_positions = {
        position
        for position, widget in enumerate(widgets)
        if position in current_by_position
        and _widget_state(current_by_position[position]) == _widget_state(widget)
    }
    if len(current) == len(widgets) == len(preserved_positions):
        return False

    removed = [row for row in current if row.position not in preserved_positions]
    for row in removed:
        db.delete(row)
    if removed:
        db.flush()
    for position, spec in enumerate(widgets):
        if position not in preserved_positions:
            db.add(_new_widget(dashboard, position, spec))
    return True


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _invalid_dashboard() from error


@router.get("", response_model=StandardListResponse[DashboardResponse])
def list_dashboards(
    user: Reader,
    db: Database,
    params: Annotated[DashboardListRequest, Query()],
) -> StandardListResponse[DashboardResponse]:
    statement = select(Dashboard).where(department_filter(db, user, Dashboard.department_id))
    if params.department_id is not None:
        statement = statement.where(Dashboard.department_id == params.department_id)
    if params.home is not None:
        statement = statement.where(Dashboard.is_home.is_(params.home))
    result = execute_standard_list(db, statement, params, DASHBOARD_LIST_SPEC)
    return StandardListResponse(
        items=_dashboard_responses(db, result.items),
        pagination=result.pagination,
    )


@router.post("", response_model=DashboardResponse, status_code=status.HTTP_201_CREATED)
def create_dashboard(
    payload: DashboardCreate,
    identity: SourceWriter,
    db: Database,
    response: Response,
) -> DashboardResponse:
    with charts.widget_source_transaction(db):
        user = get_current_user(identity)
        _require_manager(db, user, payload.department_id)
        actor = validate_dashboard_widgets(db, identity, payload.department_id, payload.widgets)
        department = db.scalar(
            select(Department)
            .where(Department.id == payload.department_id, Department.is_deleted.is_(False))
            .with_for_update(read=True, nowait=True)
            .execution_options(populate_existing=True)
        )
        if department is None:
            raise _conflict("dashboard_invalid", "The department is unavailable")
        _require_manager(db, actor, department.id)
        dashboard = Dashboard(
            org_id=department.org_id,
            department_id=department.id,
            position=payload.position,
            name=payload.name,
            refresh_cadence=payload.refresh_cadence,
        )
        db.add(dashboard)
        claim_home_if_missing(db, dashboard)
        try:
            db.flush()
            for position, widget in enumerate(payload.widgets):
                db.add(_new_widget(dashboard, position, widget))
            db.commit()
        except IntegrityError as error:
            db.rollback()
            raise _invalid_dashboard() from error
        db.refresh(dashboard)
        response.headers["Location"] = f"/api/dashboards/{dashboard.id}"
        return _dashboard_response(db, dashboard)


@router.get("/{dashboard_id}", response_model=DashboardResponse)
def read_dashboard(dashboard_id: UUID, user: Reader, db: Database) -> DashboardResponse:
    return _dashboard_response(db, _dashboard(db, user, dashboard_id))


@router.patch("/{dashboard_id}", response_model=DashboardResponse)
def update_dashboard(
    dashboard_id: UUID,
    payload: DashboardUpdate,
    identity: SourceWriter,
    db: Database,
) -> DashboardResponse:
    with charts.widget_source_transaction(db):
        user = get_current_user(identity)
        discovered = _dashboard(db, user, dashboard_id, manage=True)
        if discovered.revision != payload.revision:
            raise _stale_revision(discovered.revision)
        if discovered.is_deleted:
            raise _conflict("dashboard_archived", "Restore the Dashboard before editing it")
        expected_department = discovered.department_id
        actor = user
        if payload.widgets is not None:
            actor = validate_dashboard_widgets(
                db, identity, discovered.department_id, payload.widgets
            )
        dashboard = _dashboard(
            db, actor, dashboard_id, lock=True, manage=True, nowait=payload.widgets is not None
        )
        if dashboard.revision != payload.revision:
            raise _stale_revision(dashboard.revision)
        if dashboard.is_deleted:
            raise _conflict("dashboard_archived", "Restore the Dashboard before editing it")
        if dashboard.department_id != expected_department:
            raise _invalid_dashboard()
        if payload.widgets is not None:
            # Sources were locked first. NOWAIT avoids holding them behind a consumer writer.
            db.scalars(
                select(DashboardWidget)
                .where(DashboardWidget.dashboard_id == dashboard.id)
                .order_by(DashboardWidget.id)
                .with_for_update(nowait=True)
                .execution_options(populate_existing=True)
            ).all()
        name_changed = payload.name is not None and payload.name != dashboard.name
        position_changed = payload.position is not None and payload.position != dashboard.position
        cadence_changed = (
            payload.refresh_cadence is not None
            and payload.refresh_cadence != dashboard.refresh_cadence
        )
        widgets_changed = (
            _replace_widgets(db, dashboard, payload.widgets)
            if payload.widgets is not None
            else False
        )
        if payload.name is not None and name_changed:
            dashboard.name = payload.name
        if payload.refresh_cadence is not None and cadence_changed:
            dashboard.refresh_cadence = payload.refresh_cadence
        if payload.position is not None and position_changed:
            dashboard.position = payload.position
        if name_changed or position_changed or cadence_changed or widgets_changed:
            dashboard.revision += 1
        _commit(db)
        db.refresh(dashboard)
        return _dashboard_response(db, dashboard)


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
def archive_dashboard(
    dashboard_id: UUID,
    revision: Annotated[int, Query(ge=1)],
    user: Writer,
    db: Database,
) -> Response:
    dashboard = _dashboard(db, user, dashboard_id, lock=True, manage=True)
    if dashboard.revision != revision:
        raise _stale_revision(dashboard.revision)
    if dashboard.is_deleted:
        raise _conflict("dashboard_archived", "The Dashboard is already archived")
    dashboard.is_deleted = True
    dashboard.deleted_at = datetime.now(UTC)
    dashboard.revision += 1
    hand_over_home(db, dashboard)
    _commit(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{dashboard_id}/restore", response_model=DashboardResponse)
def restore_dashboard(
    dashboard_id: UUID,
    payload: DashboardRestore,
    user: Writer,
    db: Database,
) -> DashboardResponse:
    dashboard = _dashboard(db, user, dashboard_id, lock=True, manage=True)
    if dashboard.revision != payload.revision:
        raise _stale_revision(dashboard.revision)
    if not dashboard.is_deleted:
        raise _conflict("dashboard_not_archived", "The Dashboard is already active")
    dashboard.is_deleted = False
    dashboard.deleted_at = None
    dashboard.revision += 1
    claim_home_if_missing(db, dashboard)
    _commit(db)
    db.refresh(dashboard)
    return _dashboard_response(db, dashboard)
