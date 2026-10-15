"""Report schedules: module readers read them, module managers change them.

A scheduled run acts as the workspace, so a schedule keeps running after the
manager who set it loses access or is disabled.
"""

from datetime import datetime, time
from typing import Annotated, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import ValidationError
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.core.base_model import utc_now
from app.core.database import get_db
from app.systems.access.policy.checks import forbidden, module_filter, require_module_access
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.eligibility import is_active_account
from app.systems.access.users.models import User
from app.systems.manage.jobs.registry import failure_label
from app.systems.openview.reports.models import Report
from app.systems.openview.reports.run_service import validate_report_recipe
from app.systems.openview.reports.schedule_models import ReportSchedule
from app.systems.openview.reports.schedule_schemas import (
    Cadence,
    ScheduleCreate,
    ScheduleLastRun,
    SchedulePatch,
    ScheduleResponse,
)
from app.systems.openview.reports.schemas import ReportRecipe
from app.systems.platform.scheduling.materializer import next_due_after
from app.systems.platform.scheduling.models import ScheduledWork, WorkState
from app.systems.platform.scheduling.service import report_source


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/reports", tags=["reports"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(get_current_user)]
# Changing a schedule needs ``manage`` on the Report module; each route checks it.
Writer = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail="Report not found")


def _conflict(code: str, message: str, **extra: int) -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT,
        detail={"code": code, "message": message, **extra},
    )


def _report(db: Session, actor: User, report_id: UUID, *, lock: bool) -> Report:
    statement = select(Report).where(
        Report.id == report_id, module_filter(db, actor, AccessLevel.READ, Report.module_id)
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    report = db.scalar(statement)
    if report is None:
        raise _not_found()
    if report.is_deleted or report.deleted_at is not None:
        raise _conflict("report_archived", "Restore the Report before managing its schedule")
    return report


def _fresh_manager(db: Session, actor_id: UUID, report: Report) -> None:
    """Reload the actor under a lock and require ``manage`` on the Report module now."""

    actor = db.scalar(
        select(User)
        .where(User.id == actor_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if actor is None or not is_active_account(db, actor) or actor.deleted_at is not None:
        raise forbidden()
    require_module_access(db, actor, report.module_id, AccessLevel.MANAGE)


def _require_runnable(db: Session, report: Report) -> None:
    """An enabled schedule needs an active source module and a valid recipe."""

    if report_source(db, report, lock=True) is None:
        raise _conflict("schedule_ineligible", "The Report is unavailable for scheduling")
    validate_report_recipe(
        db, report.module_id, ReportRecipe.model_validate(report.recipe), reader=None
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


def _response(db: Session, policy: ReportSchedule) -> ScheduleResponse:
    latest = db.scalar(
        select(ScheduledWork)
        .where(
            ScheduledWork.kind == "report-run",
            ScheduledWork.report_id == policy.report_id,
            or_(
                ScheduledWork.attempt_count > 0,
                ScheduledWork.last_attempt_started_at.is_not(None),
                ScheduledWork.state.in_(("succeeded", "failed", "canceled")),
            ),
        )
        .order_by(ScheduledWork.scheduled_for.desc(), ScheduledWork.id.desc())
        .limit(1)
    )
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
        last_run=(
            ScheduleLastRun(
                state=latest.state,
                finished_at=latest.finished_at,
                failure_label=failure_label(latest.failure_code),
            ) if latest is not None else None
        ),
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
    current = utc_now()
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
        work.finished_at = current
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
    return _response(db, policy)


@router.post(
    "/{report_id}/schedule",
    response_model=ScheduleResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_report_schedule(
    report_id: UUID, payload: ScheduleCreate, user: Writer, db: Database, response: Response
) -> ScheduleResponse:
    report = _report(db, user, report_id, lock=True)
    _fresh_manager(db, user.id, report)
    if _policy(db, report.id, lock=True) is not None:
        raise _conflict("schedule_exists", "The Report already has a schedule")
    if payload.enabled:
        _require_runnable(db, report)
    policy = ReportSchedule(
        org_id=report.org_id,
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
    return _response(db, policy)


@router.patch("/{report_id}/schedule", response_model=ScheduleResponse)
def update_report_schedule(
    report_id: UUID, payload: SchedulePatch, user: Writer, db: Database
) -> ScheduleResponse:
    report = _report(db, user, report_id, lock=True)
    _fresh_manager(db, user.id, report)
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
        _require_runnable(db, report)
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
    return _response(db, policy)
