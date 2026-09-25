"""Owner-private Report recipes, retained runs, and revisioned lifecycle."""

from datetime import UTC, datetime
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy import Engine, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import (
    CurrentIdentity,
    get_current_identity,
    require_all_capabilities,
    require_fresh_capabilities,
    require_legacy_capability,
)
from app.common.listing import ListQuerySpec, StandardListResponse, execute_standard_list
from app.core.database import get_db
from app.systems.access.users.models import User, UserStatus
from app.systems.access.users.permissions import Capability
from app.systems.openview.reports.audience import (
    audience_columns,
    capture_run_eligible_users,
    report_audience,
    run_audience_clause,
    validate_audience,
)
from app.systems.openview.reports.audience_router import router as audience_router
from app.systems.openview.reports.deletion_service import delete_report_tree
from app.systems.openview.reports.models import Report, ReportRun, ReportRunRow
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
router.include_router(audience_router)
router.include_router(run_reader_router)
Reader = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_READ))]
Writer = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_WRITE))]
RunWriter = Annotated[
    User,
    Depends(require_all_capabilities(Capability.RECORDS_READ, Capability.RECORDS_WRITE)),
]
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
        return Report.id.is_(None)
    return Report.owner_id == user.id


def _report(
    db: Session, user: User, report_id: UUID, *, lock: bool = False, run_access: bool = False
) -> Report:
    statement = select(Report).where(Report.id == report_id, _owner_clause(user))
    if run_access:
        statement = statement.where(run_audience_clause(user))
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    report = db.scalar(statement)
    if report is None:
        raise _not_found()
    return report


def _response(report: Report) -> ReportResponse:
    return ReportResponse(
        id=report.id,
        owner_id=report.owner_id,
        module_id=report.module_id,
        name=report.name,
        subtitle=report.subtitle,
        revision=report.revision,
        recipe=ReportRecipe.model_validate(report.recipe),
        audience=report_audience(report),
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
    statement = select(Report).where(_owner_clause(user))
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
    validate_report_recipe(db, payload.module_id, payload.recipe)
    validate_audience(db, payload.audience)
    audience_kind, role_id, audience_user_id = audience_columns(payload.audience)
    report = Report(
        owner_id=user.id,
        module_id=payload.module_id,
        name=payload.name,
        subtitle=payload.subtitle,
        recipe=payload.recipe.model_dump(mode="json"),
        audience_kind=audience_kind,
        audience_role_id=role_id,
        audience_user_id=audience_user_id,
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
    report = _report(db, user, report_id, lock=True)
    if report.revision != payload.revision:
        raise _conflict(
            "stale_revision",
            "Report changed; reload before saving",
            current_revision=report.revision,
        )
    if report.is_deleted:
        raise _conflict("report_archived", "Restore the Report before editing it")
    module_id = payload.module_id if payload.module_id is not None else report.module_id
    recipe = payload.recipe or ReportRecipe.model_validate(report.recipe)
    validate_report_recipe(db, module_id, recipe)
    if payload.audience is not None:
        validate_audience(db, payload.audience)

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
    if payload.audience is not None:
        kind, role_id, user_id = audience_columns(payload.audience)
        for key, value in (
            ("audience_kind", kind), ("audience_role_id", role_id), ("audience_user_id", user_id)
        ):
            if value != getattr(report, key):
                changes[key] = value
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
    report = _report(db, user, report_id, lock=True)
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
    report = _report(db, user, report_id, lock=True)
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


@router.delete("/{report_id}/permanent", status_code=status.HTTP_204_NO_CONTENT)
def permanently_delete_report(
    report_id: UUID,
    revision: Annotated[int, Query(ge=1)],
    user: Writer,
    db: Database,
) -> Response:
    """Remove an archived recipe and every frozen snapshot in one audited transaction."""
    try:
        report = _report(db, user, report_id, lock=True)
        if report.revision != revision:
            raise _conflict(
                "stale_revision",
                "Report changed; reload before saving",
                current_revision=report.revision,
            )
        if not report.is_deleted:
            raise _conflict("report_not_archived", "Archive the Report before deleting it")
        delete_report_tree(db, report)
        db.commit()
    except (IntegrityError, OperationalError) as error:
        db.rollback()
        raise _conflict(
            "report_delete_conflict", "The Report changed while it was being deleted"
        ) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
    report = _report(db, user, report_id, run_access=True)
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

    # Report writes lock the recipe before policy targets; keep the same order
    # when finalizing a run so an audience edit cannot invert the lock graph.
    _report(db, user, report_id, lock=True)
    fresh_actor = require_fresh_capabilities(
        db,
        actor_id=actor_id,
        session_id=identity.session_id,
        expected_role_id=user.role_id,
        capabilities=(Capability.RECORDS_READ, Capability.RECORDS_WRITE),
    )
    report = _report(db, fresh_actor, report_id, run_access=True)
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
    validate_report_recipe(db, report.module_id, ReportRecipe.model_validate(report.recipe))
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
