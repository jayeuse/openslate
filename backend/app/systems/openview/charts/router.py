"""Revisioned saved Chart instructions, shared by the source module's readers."""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies.auth import CurrentIdentity, get_current_identity, get_current_user
from app.common.listing import ListQuerySpec, StandardListResponse, execute_standard_list
from app.core.base_model import utc_now
from app.core.database import get_db
from app.systems.access.policy.checks import module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.openview.charts import service
from app.systems.openview.charts.models import Chart
from app.systems.openview.charts.schemas import (
    ChartCreate,
    ChartListRequest,
    ChartResponse,
    ChartRevision,
    ChartSort,
    ChartUpdate,
    ChartUsageRequest,
    ChartUsageResponse,
)


def _private_cache(response: Response) -> None:
    response.headers.update(service.CACHE)


router = APIRouter(prefix="/charts", tags=["charts"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(get_current_user)]
Identity = Annotated[CurrentIdentity, Depends(get_current_identity)]
Database = Annotated[Session, Depends(get_db)]

LIST_SPEC = ListQuerySpec(
    sort_fields={
        ChartSort.NAME: cast(ColumnElement[Any], Chart.name),
        ChartSort.CREATED_AT: cast(ColumnElement[Any], Chart.created_at),
        ChartSort.UPDATED_AT: cast(ColumnElement[Any], Chart.updated_at),
    },
    default_sort=ChartSort.NAME,
    tie_breaker=cast(ColumnElement[Any], Chart.id),
    search_fields=(cast(ColumnElement[str], Chart.name),),
    deleted_field=cast(ColumnElement[bool], Chart.is_deleted),
)


@contextmanager
def _database_errors(db: Session) -> Iterator[None]:
    try:
        yield
    except IntegrityError as error:
        db.rollback()
        raise service.invalid_chart() from error
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            503,
            detail={"code": "chart_unavailable", "message": "Charts are temporarily unavailable"},
            headers=service.CACHE,
        ) from error
    except HTTPException as error:
        db.rollback()
        error.headers = {**(error.headers or {}), **service.CACHE}
        raise


def _revision(chart: Chart, revision: int) -> None:
    if chart.revision != revision:
        raise service.conflict(
            "stale_revision", "Chart changed; reload before saving", current_revision=chart.revision
        )


@router.get("", response_model=StandardListResponse[ChartResponse], operation_id="list_charts")
def list_charts(
    actor: Reader, db: Database, params: Annotated[ChartListRequest, Query()]
) -> StandardListResponse[ChartResponse]:
    with _database_errors(db):
        statement = select(Chart).where(module_filter(db, actor, AccessLevel.READ, Chart.module_id))
        if params.module_id is not None:
            statement = statement.where(Chart.module_id == params.module_id)
        if params.department_id is not None:
            statement = statement.where(Chart.department_id == params.department_id)
        result = execute_standard_list(db, statement, params, LIST_SPEC)
        return StandardListResponse(
            items=[service.response(chart) for chart in result.items], pagination=result.pagination
        )


@router.post("", response_model=ChartResponse, status_code=201, operation_id="create_chart")
def create_chart(
    payload: ChartCreate, identity: Identity, db: Database, response: Response
) -> ChartResponse:
    with _database_errors(db):
        source, actor = service.locked_source(db, identity, payload.module_id)
        query = service.validate_query(db, actor, source.id, payload.chart_type, payload.query)
        chart = Chart(
            department_id=source.department_id,
            module_id=source.id,
            name=payload.name,
            chart_type=payload.chart_type,
            query=query.model_dump(mode="json"),
        )
        db.add(chart)
        db.commit()
        db.refresh(chart)
        response.headers["Location"] = f"/api/charts/{chart.id}"
        return service.response(chart)


@router.get("/{chart_id}", response_model=ChartResponse, operation_id="read_chart")
def read_chart(chart_id: UUID, actor: Reader, db: Database) -> ChartResponse:
    with _database_errors(db):
        return service.response(service.read_chart(db, actor, chart_id))


@router.patch("/{chart_id}", response_model=ChartResponse, operation_id="update_chart")
def update_chart(
    chart_id: UUID, payload: ChartUpdate, identity: Identity, db: Database
) -> ChartResponse:
    with _database_errors(db):
        chart, source, actor = service.locked_chart(db, identity, chart_id)
        _revision(chart, payload.revision)
        if chart.is_deleted:
            raise service.conflict("chart_archived", "Restore the Chart before editing it")
        kind = payload.chart_type if payload.chart_type is not None else chart.chart_type
        query = service.validate_query(
            db, actor, source.id, kind, payload.query if payload.query is not None else chart.query
        )
        if service.incompatible_uses(db, chart.id, kind):
            raise service.invalid_chart()
        desired = {
            "name": payload.name if payload.name is not None else chart.name,
            "chart_type": kind,
            "query": query.model_dump(mode="json"),
            "department_id": source.department_id,
        }
        changed = any(getattr(chart, key) != value for key, value in desired.items())
        if changed:
            for key, value in desired.items():
                setattr(chart, key, value)
            chart.revision += 1
        db.commit()
        db.refresh(chart)
        return service.response(chart)


@router.delete("/{chart_id}", status_code=204, operation_id="archive_chart")
def archive_chart(
    chart_id: UUID, revision: Annotated[int, Query(ge=1)], identity: Identity, db: Database
) -> Response:
    with _database_errors(db):
        chart, _, actor = service.locked_chart(db, identity, chart_id, active=False)
        _revision(chart, revision)
        if chart.is_deleted:
            raise service.conflict("chart_archived", "The Chart is already archived")
        if service.in_use(db, chart.id):
            usages = service.usage(db, actor, chart.id, ChartUsageRequest())
            raise service.conflict(
                "chart_in_use",
                "The Chart is used in other locations",
                usage=usages.model_dump(mode="json"),
            )
        chart.is_deleted = True
        chart.deleted_at = utc_now()
        chart.revision += 1
        db.commit()
        return Response(status_code=204, headers=service.CACHE)


@router.post("/{chart_id}/restore", response_model=ChartResponse, operation_id="restore_chart")
def restore_chart(
    chart_id: UUID, payload: ChartRevision, identity: Identity, db: Database
) -> ChartResponse:
    with _database_errors(db):
        chart, source, _ = service.locked_chart(db, identity, chart_id)
        _revision(chart, payload.revision)
        if not chart.is_deleted:
            raise service.conflict("chart_not_archived", "The Chart is already active")
        chart.is_deleted = False
        chart.deleted_at = None
        chart.department_id = source.department_id
        chart.revision += 1
        db.commit()
        db.refresh(chart)
        return service.response(chart)


@router.get("/{chart_id}/usage", response_model=ChartUsageResponse, operation_id="read_chart_usage")
def read_chart_usage(
    chart_id: UUID, actor: Reader, db: Database, params: Annotated[ChartUsageRequest, Query()]
) -> ChartUsageResponse:
    with _database_errors(db):
        chart = service.read_chart(db, actor, chart_id)
        return service.usage(db, actor, chart.id, params)
