"""Owner-managed Report scheduling policy (not registered until integration)."""

from datetime import datetime, time
from typing import Annotated, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user, require_non_guest
from app.core.base_model import utc_now
from app.core.database import get_db
from app.systems.access.users.eligibility import is_active_account
from app.systems.access.users.models import User, UserRole
from app.systems.openview.reports.models import Report
from app.systems.openview.reports.run_service import validate_report_recipe
from app.systems.openview.reports.schedule_models import ReportSchedule
from app.systems.openview.reports.schedule_schemas import (
    Cadence,
    ScheduleCreate,
    SchedulePatch,
    ScheduleResponse,
)
from app.systems.openview.reports.schemas import ReportRecipe
from app.systems.platform.scheduling.materializer import next_due_after
from app.systems.platform.scheduling.models import ScheduledWork, WorkState
from app.systems.platform.scheduling.service import _eligible_owner


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/reports", tags=["reports"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(get_current_user)]
Writer = Annotated[User, Depends(require_non_guest)]
Database = Annotated[Session, Depends(get_db)]


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail="Report not found")


def _conflict(code: str, message: str, **extra: int) -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT,
        detail={"code": code, "message": message, **extra},
    )


def _report(db: Session, actor: User, report_id: UUID, *, lock: bool) -> Report:
    statement = select(Report).where(Report.id == report_id, Report.owner_id == actor.id)
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    report = db.scalar(statement)
    if report is None:
        raise _not_found()
    if report.is_deleted or report.deleted_at is not None:
        raise _conflict("report_archived", "Restore the Report before managing its schedule")
    return report


def _fresh_writer(db: Session, actor_id: UUID) -> User:
    actor = db.scalar(
        select(User)
        .where(User.id == actor_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if (
        actor is None
        or not is_active_account(actor)
        or actor.deleted_at is not None
        or actor.role == UserRole.GUEST.value
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Forbidden")
    return actor


def _require_enabled_eligibility(db: Session, report: Report, actor_id: UUID) -> None:
    owner = _eligible_owner(db, report, lock=True)
    if owner is None or owner.id != actor_id:
        raise _conflict("schedule_ineligible", "The Report is unavailable for scheduling")
    validate_report_recipe(
        db, report.module_id, ReportRecipe.model_validate(report.recipe), reader=owner
    )


def _policy(db: Session, report_id: UUID, *, lock: bool) -> ReportSchedule | None:
    statement = select(ReportSchedule).where(
        ReportSchedule.report_id == report_id,
        ReportSchedule.is_deleted.is_(False),
        ReportSchedule.deleted_at.is_(None),
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    return db.scalar(statement)


def _response(policy: ReportSchedule) -> ScheduleResponse:
    return ScheduleResponse(
        id=policy.id,
        report_id=policy.report_id,
        revision=policy.revision,
        enabled=policy.enabled,
        cadence=cast(Cadence, policy.cadence),
        timezone_name=policy.timezone_name,
        local_time=policy.local_time.strftime("%H:%M"),
        weekday=policy.weekday,
        month_day=policy.month_day,
        next_due_at=policy.next_due_at if policy.enabled else None,
        created_at=policy.created_at,
        updated_at=policy.updated_at,
    )


def _due(payload: ScheduleCreate) -> datetime:
    return next_due_after(
        cadence=payload.cadence,
        timezone_name=payload.timezone_name,
        local_time=time.fromisoformat(payload.local_time),
        weekday=payload.weekday,
        month_day=payload.month_day,
        after=utc_now(),
    )


def _cancel_old_work(db: Session, report_id: UUID) -> None:
    outstanding = db.scalars(
        select(ScheduledWork)
        .where(
            ScheduledWork.report_id == report_id,
            ScheduledWork.state.in_((WorkState.PENDING, WorkState.RUNNING)),
        )
        .order_by(ScheduledWork.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    for work in outstanding:
        work.state = WorkState.CANCELED
        work.failure_code = "schedule_changed"
        work.lease_token = None
        work.lease_expires_at = None


def _commit(db: Session) -> None:
    try:
        db.commit()
    except (IntegrityError, OperationalError) as error:
        db.rollback()
        raise _conflict(
            "schedule_conflict", "The schedule changed; reload before saving"
        ) from error


@router.get("/{report_id}/schedule", response_model=ScheduleResponse)
def read_report_schedule(report_id: UUID, user: Reader, db: Database) -> ScheduleResponse:
    report = _report(db, user, report_id, lock=False)
    policy = _policy(db, report.id, lock=False)
    if policy is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Report schedule not found")
    return _response(policy)


@router.post(
    "/{report_id}/schedule",
    response_model=ScheduleResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_report_schedule(
    report_id: UUID, payload: ScheduleCreate, user: Writer, db: Database, response: Response
) -> ScheduleResponse:
    report = _report(db, user, report_id, lock=True)
    if _policy(db, report.id, lock=True) is not None:
        raise _conflict("schedule_exists", "The Report already has a schedule")
    if payload.enabled:
        _require_enabled_eligibility(db, report, user.id)
    else:
        _fresh_writer(db, user.id)
    policy = ReportSchedule(
        report_id=report.id,
        enabled=payload.enabled,
        cadence=payload.cadence,
        timezone_name=payload.timezone_name,
        local_time=time.fromisoformat(payload.local_time),
        weekday=payload.weekday,
        month_day=payload.month_day,
        next_due_at=_due(payload),
    )
    db.add(policy)
    _commit(db)
    db.refresh(policy)
    response.headers["Location"] = f"/api/reports/{report.id}/schedule"
    return _response(policy)


@router.patch("/{report_id}/schedule", response_model=ScheduleResponse)
def update_report_schedule(
    report_id: UUID, payload: SchedulePatch, user: Writer, db: Database
) -> ScheduleResponse:
    report = _report(db, user, report_id, lock=True)
    policy = _policy(db, report.id, lock=True)
    if policy is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Report schedule not found")
    if policy.revision != payload.revision:
        raise _conflict(
            "stale_revision",
            "Schedule changed; reload before saving",
            current_revision=policy.revision,
        )
    values: dict[str, object] = {
        "enabled": policy.enabled,
        "cadence": policy.cadence,
        "timezone_name": policy.timezone_name,
        "local_time": policy.local_time.strftime("%H:%M"),
        "weekday": policy.weekday,
        "month_day": policy.month_day,
    }
    values.update(payload.model_dump(exclude_unset=True, exclude={"revision"}))
    try:
        merged = ScheduleCreate.model_validate(values)
    except ValidationError as error:
        raise HTTPException(422, detail=error.errors(include_context=False)) from error
    timing_changed = any(
        getattr(policy, name) != value
        for name, value in (
            ("cadence", merged.cadence),
            ("timezone_name", merged.timezone_name),
            ("local_time", time.fromisoformat(merged.local_time)),
            ("weekday", merged.weekday),
            ("month_day", merged.month_day),
        )
    )
    enable = not policy.enabled and merged.enabled
    disable = policy.enabled and not merged.enabled
    if merged.enabled:
        _require_enabled_eligibility(db, report, user.id)
    else:
        _fresh_writer(db, user.id)
    if disable or timing_changed:
        _cancel_old_work(db, report.id)
    if enable or timing_changed:
        policy.next_due_at = _due(merged)
    if enable or disable or timing_changed:
        policy.enabled = merged.enabled
        policy.cadence = merged.cadence
        policy.timezone_name = merged.timezone_name
        policy.local_time = time.fromisoformat(merged.local_time)
        policy.weekday = merged.weekday
        policy.month_day = merged.month_day
        policy.revision += 1
    _commit(db)
    db.refresh(policy)
    return _response(policy)
