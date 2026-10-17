"""Report output reads for users who were module readers at run time and still are."""

from datetime import datetime
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session, load_only
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user
from app.common.listing import ListQuerySpec, StandardListResponse, execute_standard_list
from app.core.database import get_db
from app.systems.access.policy.checks import module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.openview.reports.models import Report, ReportRun, ReportRunEligibleUser
from app.systems.openview.reports.run_service import REPORT_RUN_METADATA_COLUMNS
from app.systems.openview.reports.schemas import (
    ReportRunListRequest,
    ReportRunResponse,
    ReportRunSort,
)

router = APIRouter()
# Eligible readers need current READ on both the captured module and the parent Report.
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]

RUN_LIST_SPEC = ListQuerySpec(
    sort_fields={ReportRunSort.CREATED_AT: cast(ColumnElement[Any], ReportRun.created_at)},
    default_sort=ReportRunSort.CREATED_AT,
    tie_breaker=cast(ColumnElement[Any], ReportRun.id),
)


class SharedReportRunResponse(BaseModel):
    """Only safe discovery fields, never a recipe or output bytes."""

    model_config = ConfigDict(extra="forbid")

    id: UUID
    report_id: UUID
    report_name: str
    recipe_revision: int
    row_count: int
    headings: list[str]
    created_at: datetime
    status: Literal["succeeded"] = "succeeded"


def run_response(run: ReportRun) -> ReportRunResponse:
    return ReportRunResponse(
        id=run.id,
        report_id=run.report_id,
        recipe_revision=run.recipe_revision,
        row_count=run.row_count,
        headings=run.headings,
        created_at=run.created_at,
    )


def _report_for_output(db: Session, user: User, report_id: UUID) -> Report:
    report = db.scalar(
        select(Report)
        .options(load_only(Report.id, Report.is_deleted, raiseload=True))
        .where(
            Report.id == report_id,
            module_filter(db, user, AccessLevel.READ, Report.module_id),
        )
    )
    if report is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Report not found")
    if report.is_deleted:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "report_archived",
                "message": "Restore the Report before reading its runs",
            },
        )
    return report


def accessible_run(
    db: Session, report_id: UUID, run_id: UUID, user: User, *, metadata_only: bool = False
) -> ReportRun:
    statement = (
        select(ReportRun)
        .join(
            ReportRunEligibleUser,
            ReportRunEligibleUser.run_id == ReportRun.id,
        )
        .where(
            ReportRun.id == run_id,
            ReportRun.report_id == report_id,
            ReportRun.is_deleted.is_(False),
            ReportRunEligibleUser.user_id == user.id,
            module_filter(db, user, AccessLevel.READ, ReportRun.module_id),
        )
    )
    if metadata_only:
        statement = statement.options(load_only(*REPORT_RUN_METADATA_COLUMNS, raiseload=True))
    run = db.scalar(statement)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Report run not found")
    return run


@router.get("/shared-runs", response_model=StandardListResponse[SharedReportRunResponse])
def discover_shared_report_runs(
    user: Reader,
    db: Database,
    params: Annotated[ReportRunListRequest, Query()],
) -> StandardListResponse[SharedReportRunResponse]:
    """Count and page only runs visible under both immutable and current policy."""

    statement = (
        select(ReportRun)
        .options(load_only(*REPORT_RUN_METADATA_COLUMNS, raiseload=True))
        .join(Report, Report.id == ReportRun.report_id)
        .join(ReportRunEligibleUser, ReportRunEligibleUser.run_id == ReportRun.id)
        .where(
            ReportRunEligibleUser.user_id == user.id,
            ReportRun.is_deleted.is_(False),
            Report.is_deleted.is_(False),
            Report.deleted_at.is_(None),
            module_filter(db, user, AccessLevel.READ, Report.module_id),
            module_filter(db, user, AccessLevel.READ, ReportRun.module_id),
        )
    )
    result = execute_standard_list(db, statement, params, RUN_LIST_SPEC)
    report_ids = {run.report_id for run in result.items}
    names: dict[UUID, str] = {
        report_id: name
        for report_id, name in db.execute(
            select(Report.id, Report.name).where(Report.id.in_(report_ids))
        ).tuples()
    }
    return StandardListResponse(
        items=[
            SharedReportRunResponse(
                **run_response(run).model_dump(), report_name=names[run.report_id]
            )
            for run in result.items
        ],
        pagination=result.pagination,
    )


@router.get("/{report_id}/runs", response_model=StandardListResponse[ReportRunResponse])
def list_report_runs(
    report_id: UUID,
    user: Reader,
    db: Database,
    params: Annotated[ReportRunListRequest, Query()],
) -> StandardListResponse[ReportRunResponse]:
    report = _report_for_output(db, user, report_id)
    statement = (
        select(ReportRun)
        .options(load_only(*REPORT_RUN_METADATA_COLUMNS, raiseload=True))
        .join(ReportRunEligibleUser, ReportRunEligibleUser.run_id == ReportRun.id)
        .where(
            ReportRun.report_id == report.id,
            ReportRun.is_deleted.is_(False),
            ReportRunEligibleUser.user_id == user.id,
            module_filter(db, user, AccessLevel.READ, ReportRun.module_id),
        )
    )
    result = execute_standard_list(db, statement, params, RUN_LIST_SPEC)
    return StandardListResponse(
        items=[run_response(run) for run in result.items], pagination=result.pagination
    )


@router.get("/{report_id}/runs/{run_id}", response_model=ReportRunResponse)
def read_report_run(report_id: UUID, run_id: UUID, user: Reader, db: Database) -> ReportRunResponse:
    report = _report_for_output(db, user, report_id)
    return run_response(accessible_run(db, report.id, run_id, user, metadata_only=True))


@router.get("/{report_id}/runs/{run_id}/csv")
def download_report_run_csv(report_id: UUID, run_id: UUID, user: Reader, db: Database) -> Response:
    report = _report_for_output(db, user, report_id)
    run = accessible_run(db, report.id, run_id, user)
    return Response(
        run.csv_bytes,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="report-{run.id}.csv"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
