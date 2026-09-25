"""Revisioned, private Dashboard metadata and ordered chart widgets."""

from datetime import UTC, datetime
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_legacy_capability
from app.common.listing import ListQuerySpec, StandardListResponse, execute_standard_list
from app.core.database import get_db
from app.systems.access.users.models import User, UserStatus
from app.systems.access.users.permissions import Capability
from app.systems.openview.dashboards.models import Dashboard, DashboardDefault, DashboardWidget
from app.systems.openview.dashboards.schemas import (
    DashboardCreate,
    DashboardDefaultResponse,
    DashboardDefaultSet,
    DashboardListRequest,
    DashboardResponse,
    DashboardRestore,
    DashboardSort,
    DashboardUpdate,
    DashboardWidgetResponse,
    DashboardWidgetSpec,
)
from app.systems.openview.dashboards.widget_validation import validate_dashboard_widgets


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(
    prefix="/dashboards",
    tags=["dashboards"],
    dependencies=[Depends(_private_cache)],
)
Reader = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_READ))]
Writer = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_WRITE))]
Database = Annotated[Session, Depends(get_db)]

DASHBOARD_LIST_SPEC = ListQuerySpec(
    sort_fields={
        DashboardSort.NAME: cast(ColumnElement[Any], Dashboard.name),
        DashboardSort.CREATED_AT: cast(ColumnElement[Any], Dashboard.created_at),
        DashboardSort.UPDATED_AT: cast(ColumnElement[Any], Dashboard.updated_at),
    },
    default_sort=DashboardSort.NAME,
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


def _owner_clause(user: User) -> ColumnElement[bool]:
    role = user.role
    if (
        user.status != UserStatus.ACTIVE.value
        or user.is_deleted
        or user.deleted_at is not None
        or role is None
        or role.is_deleted
        or role.deleted_at is not None
        or role.id != user.role_id
    ):
        return Dashboard.id.is_(None)
    return Dashboard.owner_id == user.id


def _dashboard(db: Session, user: User, dashboard_id: UUID, *, lock: bool = False) -> Dashboard:
    statement = select(Dashboard).where(
        Dashboard.id == dashboard_id,
        _owner_clause(user),
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    dashboard = db.scalar(statement)
    if dashboard is None:
        raise _not_found()
    return dashboard


def _widget_response(widget: DashboardWidget) -> DashboardWidgetResponse:
    return DashboardWidgetResponse(
        id=widget.id,
        position=widget.position,
        widget_type=widget.widget_type,
        config=widget.config,
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
            owner_id=dashboard.owner_id,
            name=dashboard.name,
            refresh_cadence=dashboard.refresh_cadence,
            revision=dashboard.revision,
            is_deleted=dashboard.is_deleted,
            created_at=dashboard.created_at,
            updated_at=dashboard.updated_at,
            widgets=grouped[dashboard.id],
        )
        for dashboard in dashboards
    ]


def _dashboard_response(db: Session, dashboard: Dashboard) -> DashboardResponse:
    return _dashboard_responses(db, [dashboard])[0]


def _stored_config(widget: DashboardWidgetSpec) -> dict[str, Any]:
    return widget.config.model_dump(mode="json")


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
    desired = [(widget.widget_type, _stored_config(widget)) for widget in widgets]
    current_by_position = {widget.position: widget for widget in current}
    preserved_positions = {
        position
        for position, (widget_type, config) in enumerate(desired)
        if position in current_by_position
        and current_by_position[position].widget_type == widget_type
        and current_by_position[position].config == config
    }
    if len(current) == len(desired) == len(preserved_positions):
        return False

    removed = [widget for widget in current if widget.position not in preserved_positions]
    for widget in removed:
        db.delete(widget)
    if removed:
        db.flush()
    for position, (widget_type, config) in enumerate(desired):
        if position in preserved_positions:
            continue
        db.add(
            DashboardWidget(
                dashboard_id=dashboard.id,
                position=position,
                widget_type=widget_type,
                config=config,
            )
        )
    return True


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _invalid_dashboard() from error


def _commit_default(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict(
            "default_dashboard_invalid", "Unable to save the default Dashboard"
        ) from error


@router.get("", response_model=StandardListResponse[DashboardResponse])
def list_dashboards(
    user: Reader,
    db: Database,
    params: Annotated[DashboardListRequest, Query()],
) -> StandardListResponse[DashboardResponse]:
    statement = select(Dashboard).where(_owner_clause(user))
    result = execute_standard_list(db, statement, params, DASHBOARD_LIST_SPEC)
    return StandardListResponse(
        items=_dashboard_responses(db, result.items),
        pagination=result.pagination,
    )


@router.post("", response_model=DashboardResponse, status_code=status.HTTP_201_CREATED)
def create_dashboard(
    payload: DashboardCreate,
    user: Writer,
    db: Database,
    response: Response,
) -> DashboardResponse:
    validate_dashboard_widgets(db, payload.widgets)
    dashboard = Dashboard(
        owner_id=user.id,
        name=payload.name,
        refresh_cadence=payload.refresh_cadence,
    )
    db.add(dashboard)
    try:
        db.flush()
        for position, widget in enumerate(payload.widgets):
            db.add(
                DashboardWidget(
                    dashboard_id=dashboard.id,
                    position=position,
                    widget_type=widget.widget_type,
                    config=_stored_config(widget),
                )
            )
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _invalid_dashboard() from error
    db.refresh(dashboard)
    response.headers["Location"] = f"/api/dashboards/{dashboard.id}"
    return _dashboard_response(db, dashboard)


@router.get("/default", response_model=DashboardDefaultResponse)
def read_personal_default(user: Reader, db: Database) -> DashboardDefaultResponse:
    dashboard_id = db.scalar(
        select(DashboardDefault.dashboard_id)
        .join(Dashboard, Dashboard.id == DashboardDefault.dashboard_id)
        .where(
            DashboardDefault.user_id == user.id,
            _owner_clause(user),
            Dashboard.is_deleted.is_(False),
        )
    )
    return DashboardDefaultResponse(dashboard_id=dashboard_id)


@router.put("/default", response_model=DashboardDefaultResponse)
def set_personal_default(
    payload: DashboardDefaultSet,
    user: Writer,
    db: Database,
) -> DashboardDefaultResponse:
    # Serialize one user's preference writes even when no default row exists yet.
    db.scalar(select(User.id).where(User.id == user.id).with_for_update())
    if payload.dashboard_id is not None:
        dashboard = db.scalar(
            select(Dashboard)
            .where(
                Dashboard.id == payload.dashboard_id,
                _owner_clause(user),
                Dashboard.is_deleted.is_(False),
            )
            .with_for_update()
        )
        if dashboard is None:
            raise _conflict("default_dashboard_invalid", "The default Dashboard is unavailable")

    existing = db.scalar(
        select(DashboardDefault)
        .where(DashboardDefault.user_id == user.id)
        .with_for_update()
    )
    if payload.dashboard_id is None:
        if existing is not None:
            db.delete(existing)
            _commit_default(db)
        return DashboardDefaultResponse(dashboard_id=None)

    if existing is not None and existing.dashboard_id == payload.dashboard_id:
        return DashboardDefaultResponse(dashboard_id=payload.dashboard_id)
    if existing is None:
        db.add(DashboardDefault(user_id=user.id, dashboard_id=payload.dashboard_id))
    else:
        existing.dashboard_id = payload.dashboard_id
    _commit_default(db)
    return DashboardDefaultResponse(dashboard_id=payload.dashboard_id)


@router.get("/{dashboard_id}", response_model=DashboardResponse)
def read_dashboard(dashboard_id: UUID, user: Reader, db: Database) -> DashboardResponse:
    return _dashboard_response(db, _dashboard(db, user, dashboard_id))


@router.patch("/{dashboard_id}", response_model=DashboardResponse)
def update_dashboard(
    dashboard_id: UUID,
    payload: DashboardUpdate,
    user: Writer,
    db: Database,
) -> DashboardResponse:
    dashboard = _dashboard(db, user, dashboard_id, lock=True)
    if dashboard.revision != payload.revision:
        raise _stale_revision(dashboard.revision)
    if dashboard.is_deleted:
        raise _conflict("dashboard_archived", "Restore the Dashboard before editing it")

    if payload.widgets is not None:
        validate_dashboard_widgets(db, payload.widgets)
    name_changed = payload.name is not None and payload.name != dashboard.name
    cadence_changed = (
        payload.refresh_cadence is not None
        and payload.refresh_cadence != dashboard.refresh_cadence
    )
    widgets_changed = (
        _replace_widgets(db, dashboard, payload.widgets) if payload.widgets is not None else False
    )
    if payload.name is not None and name_changed:
        dashboard.name = payload.name
    if payload.refresh_cadence is not None and cadence_changed:
        dashboard.refresh_cadence = payload.refresh_cadence
    if name_changed or cadence_changed or widgets_changed:
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
    dashboard = _dashboard(db, user, dashboard_id, lock=True)
    if dashboard.revision != revision:
        raise _stale_revision(dashboard.revision)
    if dashboard.is_deleted:
        raise _conflict("dashboard_archived", "The Dashboard is already archived")
    dashboard.is_deleted = True
    dashboard.deleted_at = datetime.now(UTC)
    dashboard.revision += 1
    _commit(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{dashboard_id}/restore", response_model=DashboardResponse)
def restore_dashboard(
    dashboard_id: UUID,
    payload: DashboardRestore,
    user: Writer,
    db: Database,
) -> DashboardResponse:
    dashboard = _dashboard(db, user, dashboard_id, lock=True)
    if dashboard.revision != payload.revision:
        raise _stale_revision(dashboard.revision)
    if not dashboard.is_deleted:
        raise _conflict("dashboard_not_archived", "The Dashboard is already active")
    dashboard.is_deleted = False
    dashboard.deleted_at = None
    dashboard.revision += 1
    _commit(db)
    db.refresh(dashboard)
    return _dashboard_response(db, dashboard)
