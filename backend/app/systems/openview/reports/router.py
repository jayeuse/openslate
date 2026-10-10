"""Report recipes, retained runs, and revisioned lifecycle.

Every reader of the module reads its Reports and runs them on demand (a guest
never writes a run). Only ``manage`` on the module creates, changes or deletes a
Report.
"""

from datetime import UTC, datetime
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy import Engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import (
    CurrentIdentity,
    get_current_identity,
    get_current_user,
    require_non_guest,
)
from app.common.listing import ListQuerySpec, StandardListResponse, execute_standard_list
from app.core.database import get_db
from app.systems.access.policy.checks import (
    module_filter,
    require_fresh_module_access,
    require_module_access,
)
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.openview.reports.eligibility import capture_run_eligible_users
from app.systems.openview.reports.models import Report, ReportRun, ReportRunRow
from app.systems.openview.reports.purge_router import router as purge_router
from app.systems.openview.reports.run_reader_router import (
    accessible_run,
    run_response,
)
from app.systems.openview.reports.run_reader_router import router as run_reader_router
from app.systems.openview.reports.run_service import (
    capture_report_snapshot,
    validate_report_recipe,
)
from app.systems.openview.reports.schemas import (
    ReportCreate,
    ReportListRequest,
    ReportRecipe,
    ReportResponse,
    ReportRevisionRequest,
    ReportRunResponse,
    ReportSort,
    ReportUpdate,
)


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/reports", tags=["reports"], dependencies=[Depends(_private_cache)])
router.include_router(run_reader_router)
router.include_router(purge_router)
Reader = Annotated[User, Depends(get_current_user)]
# Changing a Report needs ``manage`` on its module; each route checks the module.
Writer = Annotated[User, Depends(get_current_user)]
RunWriter = Annotated[User, Depends(require_non_guest)]
Identity = Annotated[CurrentIdentity, Depends(get_current_identity)]
Database = Annotated[Session, Depends(get_db)]

REPORT_LIST_SPEC = ListQuerySpec(
    sort_fields={
        ReportSort.NAME: cast(ColumnElement[Any], Report.name),
        ReportSort.CREATED_AT: cast(ColumnElement[Any], Report.created_at),
        ReportSort.UPDATED_AT: cast(ColumnElement[Any], Report.updated_at),
    },
    default_sort=ReportSort.NAME,
    tie_breaker=cast(ColumnElement[Any], Report.id),
    deleted_field=cast(ColumnElement[bool], Report.is_deleted),
    search_fields=(cast(ColumnElement[str], Report.name),),
)


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail="Report not found")


def _conflict(code: str, message: str, **extra: int) -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT,
        detail={"code": code, "message": message, **extra},
    )


def _invalid_report() -> HTTPException:
    return _conflict("report_invalid", "The Report source or selected fields are unavailable")


def _readable(db: Session, user: User) -> ColumnElement[bool]:
    """Every user who can read the Report module reads the Report."""

    return module_filter(db, user, AccessLevel.READ, Report.module_id)


def _report(
    db: Session, user: User, report_id: UUID, *, lock: bool = False, manage: bool = False
) -> Report:
    statement = select(Report).where(Report.id == report_id, _readable(db, user))
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    report = db.scalar(statement)
    if report is None:
        raise _not_found()
    if manage:
        require_module_access(db, user, report.module_id, AccessLevel.MANAGE)
    return report


def _response(report: Report) -> ReportResponse:
    return ReportResponse(
        id=report.id,
        module_id=report.module_id,
        name=report.name,
        subtitle=report.subtitle,
        revision=report.revision,
        recipe=ReportRecipe.model_validate(report.recipe),
        is_deleted=report.is_deleted,
        created_at=report.created_at,
        updated_at=report.updated_at,
    )


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _invalid_report() from error


@router.get("", response_model=StandardListResponse[ReportResponse])
def list_reports(
    user: Reader,
    db: Database,
    params: Annotated[ReportListRequest, Query()],
) -> StandardListResponse[ReportResponse]:
    statement = select(Report).where(_readable(db, user))
    if params.module_id is not None:
        statement = statement.where(Report.module_id == params.module_id)
    result = execute_standard_list(db, statement, params, REPORT_LIST_SPEC)
    return StandardListResponse(
        items=[_response(report) for report in result.items],
        pagination=result.pagination,
    )


@router.post("", response_model=ReportResponse, status_code=status.HTTP_201_CREATED)
def create_report(
    payload: ReportCreate,
    user: Writer,
    db: Database,
    response: Response,
) -> ReportResponse:
    require_module_access(db, user, payload.module_id, AccessLevel.MANAGE)
    validate_report_recipe(db, payload.module_id, payload.recipe, reader=user)
    report = Report(
        module_id=payload.module_id,
        name=payload.name,
        subtitle=payload.subtitle,
        recipe=payload.recipe.model_dump(mode="json"),
    )
    db.add(report)
    _commit(db)
    db.refresh(report)
    response.headers["Location"] = f"/api/reports/{report.id}"
    return _response(report)


@router.get("/{report_id}", response_model=ReportResponse)
def read_report(report_id: UUID, user: Reader, db: Database) -> ReportResponse:
    return _response(_report(db, user, report_id))


@router.patch("/{report_id}", response_model=ReportResponse)
def update_report(
    report_id: UUID,
    payload: ReportUpdate,
    user: Writer,
    db: Database,
) -> ReportResponse:
    report = _report(db, user, report_id, lock=True, manage=True)
    if report.revision != payload.revision:
        raise _conflict(
            "stale_revision",
            "Report changed; reload before saving",
            current_revision=report.revision,
        )
    if report.is_deleted:
        raise _conflict("report_archived", "Restore the Report before editing it")
    module_id = payload.module_id if payload.module_id is not None else report.module_id
    if module_id != report.module_id:
        require_module_access(db, user, module_id, AccessLevel.MANAGE)
    recipe = payload.recipe or ReportRecipe.model_validate(report.recipe)
    validate_report_recipe(db, module_id, recipe, reader=user)

    changes: dict[str, object] = {}
    for key in ("module_id", "name", "subtitle"):
        if key in payload.model_fields_set:
            value = getattr(payload, key)
            if value != getattr(report, key):
                changes[key] = value
    if payload.recipe is not None:
        stored_recipe = payload.recipe.model_dump(mode="json")
        if stored_recipe != report.recipe:
            changes["recipe"] = stored_recipe
    for key, value in changes.items():
        setattr(report, key, value)
    if changes:
        report.revision += 1
    _commit(db)
    db.refresh(report)
    return _response(report)


@router.delete("/{report_id}", status_code=status.HTTP_204_NO_CONTENT)
def archive_report(
    report_id: UUID,
    revision: Annotated[int, Query(ge=1)],
    user: Writer,
    db: Database,
) -> Response:
    report = _report(db, user, report_id, lock=True, manage=True)
    if report.revision != revision:
        raise _conflict(
            "stale_revision",
            "Report changed; reload before saving",
            current_revision=report.revision,
        )
    if report.is_deleted:
        raise _conflict("report_archived", "The Report is already archived")
    report.is_deleted = True
    report.deleted_at = datetime.now(UTC)
    report.revision += 1
    _commit(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{report_id}/restore", response_model=ReportResponse)
def restore_report(
    report_id: UUID,
    payload: ReportRevisionRequest,
    user: Writer,
    db: Database,
) -> ReportResponse:
    report = _report(db, user, report_id, lock=True, manage=True)
    if report.revision != payload.revision:
        raise _conflict(
            "stale_revision",
            "Report changed; reload before saving",
            current_revision=report.revision,
        )
    if not report.is_deleted:
        raise _conflict("report_not_archived", "The Report is already active")
    report.is_deleted = False
    report.deleted_at = None
    report.revision += 1
    _commit(db)
    db.refresh(report)
    return _response(report)


@router.post(
    "/{report_id}/runs",
    response_model=ReportRunResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_report_run(
    report_id: UUID,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
    user: RunWriter,
    identity: Identity,
    db: Database,
    response: Response,
) -> ReportRunResponse:
    report = _report(db, user, report_id)
    if report.is_deleted:
        raise _conflict("report_archived", "Restore the Report before running it")
    existing = db.scalar(
        select(ReportRun).where(
            ReportRun.report_id == report.id,
            ReportRun.idempotency_key == idempotency_key,
        )
    )
    if existing is not None:
        accessible_run(db, report.id, existing.id, user.id)
        response.headers["Location"] = f"/api/reports/{report_id}/runs/{existing.id}"
        return run_response(existing)

    actor_id = user.id
    bind = db.get_bind()
    engine = bind if isinstance(bind, Engine) else bind.engine
    db.rollback()
    snapshot = capture_report_snapshot(engine, report_id, actor_id)

    # Report writes lock the recipe before access rows; keep the same order
    # when finalizing a run so a concurrent edit cannot invert the lock graph.
    _report(db, user, report_id, lock=True)
    fresh_actor = require_fresh_module_access(
        db,
        actor_id=actor_id,
        session_id=identity.session_id,
        module_id=snapshot.module_id,
        level=AccessLevel.READ,
    )
    report = _report(db, fresh_actor, report_id)
    if report.is_deleted:
        raise _conflict("report_archived", "Restore the Report before running it")
    existing = db.scalar(
        select(ReportRun).where(
            ReportRun.report_id == report.id,
            ReportRun.idempotency_key == idempotency_key,
        )
    )
    if existing is not None:
        accessible_run(db, report.id, existing.id, fresh_actor.id)
        response.headers["Location"] = f"/api/reports/{report_id}/runs/{existing.id}"
        return run_response(existing)
    if (
        report.revision != snapshot.recipe_revision
        or report.module_id != snapshot.module_id
        or report.recipe != snapshot.recipe
    ):
        raise _conflict(
            "stale_revision",
            "Report changed while the run was being prepared",
            current_revision=report.revision,
        )
    validate_report_recipe(
        db, report.module_id, ReportRecipe.model_validate(report.recipe), reader=fresh_actor
    )
    run = ReportRun(
        report_id=report.id,
        module_id=snapshot.module_id,
        idempotency_key=idempotency_key,
        recipe_revision=snapshot.recipe_revision,
        recipe=snapshot.recipe,
        headings=snapshot.headings,
        row_count=len(snapshot.rows),
        csv_bytes=snapshot.csv_bytes,
    )
    db.add(run)
    try:
        db.flush()
        capture_run_eligible_users(db, report, run.id)
        for position, (record_id, cells) in enumerate(snapshot.rows):
            db.add(
                ReportRunRow(
                    run_id=run.id,
                    position=position,
                    record_id=record_id,
                    cells=cells,
                )
            )
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict(
            "report_source_changed", "The Report source changed while the run was saved"
        ) from error
    db.refresh(run)
    response.headers["Location"] = f"/api/reports/{report_id}/runs/{run.id}"
    return run_response(run)
