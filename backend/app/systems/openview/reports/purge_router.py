"""Administrator-confirmed purge of a Report and every retained descendant."""

import hashlib
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import Select, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.common.dependencies import require_admin, require_fresh_exact_admin
from app.core.config import get_settings
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.manage.audit.context import get_audit_context
from app.systems.openview.reports.deletion_service import delete_report_tree
from app.systems.openview.reports.models import (
    Report,
    ReportRun,
    ReportRunEligibleUser,
    ReportRunRow,
)
from app.systems.openview.reports.schedule_models import ReportSchedule
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork
from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleConfirmationNameMismatch,
    LifecycleError,
    LifecycleNotFound,
    LifecyclePlanDriftError,
    LifecyclePurgeDisabled,
    LifecyclePurgePreconditionError,
)
from app.systems.sandbox.lifecycle.planner import canonical_lifecycle_digest
from app.systems.sandbox.lifecycle.purge_support import (
    PURGE_DISABLED_MESSAGE,
    last_successful_backup_at,
    purge_row_state,
)
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleImpactResponse,
    LifecycleMutationResponse,
    LifecycleOperation,
    LifecyclePurgePreviewResponse,
    LifecyclePurgeRequest,
    LifecycleRowState,
    LifecycleTargetType,
)
from app.systems.sandbox.lifecycle.service import (
    challenge_impact_digest,
    issue_challenge,
    verify_challenge,
)

router = APIRouter(tags=["reports"])
Admin = Annotated[User, Depends(require_admin)]
Database = Annotated[Session, Depends(get_db)]


def _enabled() -> None:
    if not get_settings().lifecycle_purge_enabled:
        raise LifecyclePurgeDisabled(PURGE_DISABLED_MESSAGE)


def _mapped(exc: LifecycleError) -> HTTPException:
    return HTTPException(exc.status_code, detail={"code": str(exc.code), "message": exc.detail})


def _report(db: Session, report_id: UUID, *, lock: bool = False) -> Report:
    statement = select(Report).where(Report.id == report_id)
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    report = db.scalar(statement)
    if report is None:
        raise LifecycleNotFound("Report not found")
    if not report.is_deleted or report.deleted_at is None:
        raise LifecyclePurgePreconditionError("Archive the Report before permanently deleting it")
    return report


def _impact(
    db: Session, actor_id: UUID, report: Report, *, lock: bool = False
) -> LifecycleImpactResponse:
    rows = [purge_row_state(report)]

    # The Report is the first lock. Its FK lock excludes newly inserted children.
    def statement_locked(statement: Select[Any]) -> Select[Any]:
        return (
            statement.with_for_update().execution_options(populate_existing=True)
            if lock
            else statement
        )

    for schedule in db.scalars(
        statement_locked(
            select(ReportSchedule)
            .where(ReportSchedule.report_id == report.id)
            .order_by(ReportSchedule.id)
        )
    ):
        rows.append(purge_row_state(schedule))
    work = list(
        db.scalars(
            statement_locked(
                select(ScheduledWork)
                .where(ScheduledWork.report_id == report.id)
                .order_by(ScheduledWork.id)
            )
        )
    )
    rows.extend(purge_row_state(item) for item in work)
    if work:
        rows.extend(
            purge_row_state(item)
            for item in db.scalars(
                statement_locked(
                    select(InAppNotification)
                    .where(InAppNotification.work_id.in_([item.id for item in work]))
                    .order_by(InAppNotification.id)
                )
            )
        )
    runs = list(
        db.scalars(
            statement_locked(
                select(ReportRun).where(ReportRun.report_id == report.id).order_by(ReportRun.id)
            )
        )
    )
    rows.extend(purge_row_state(run) for run in runs)
    if runs:
        run_map = {run.id: run for run in runs}
        for eligible in db.scalars(
            statement_locked(
                select(ReportRunEligibleUser)
                .where(ReportRunEligibleUser.run_id.in_(run_map))
                .order_by(ReportRunEligibleUser.run_id, ReportRunEligibleUser.user_id)
            )
        ):
            rows.append(
                LifecycleRowState(
                    entity_type=ReportRunEligibleUser.__tablename__,
                    entity_id=eligible.run_id,
                    is_deleted=False,
                    deleted_at=None,
                    updated_at=run_map[eligible.run_id].updated_at,
                    state_fingerprint=hashlib.sha256(
                        f"{eligible.run_id}:{eligible.user_id}".encode()
                    ).hexdigest(),
                )
            )
        rows.extend(
            purge_row_state(item)
            for item in db.scalars(
                statement_locked(
                    select(ReportRunRow)
                    .where(ReportRunRow.run_id.in_(run_map))
                    .order_by(ReportRunRow.id)
                )
            )
        )
    digest = canonical_lifecycle_digest(
        LifecycleOperation.PURGE, LifecycleTargetType.REPORT, report.id, actor_id, rows
    )
    return LifecycleImpactResponse(
        target_type=LifecycleTargetType.REPORT,
        target_id=report.id,
        operation=LifecycleOperation.PURGE,
        actor_id=actor_id,
        rows=rows,
        impact_digest=digest,
    )


@router.post("/{report_id}/purge/preview", response_model=LifecyclePurgePreviewResponse)
def preview_report_purge(
    report_id: UUID, user: Admin, db: Database, response: Response
) -> LifecyclePurgePreviewResponse:
    response.headers["Cache-Control"] = "no-store"
    try:
        _enabled()
        require_fresh_exact_admin(db, user.id)
        report = _report(db, report_id)
        impact = _impact(db, user.id, report)
        name = report.name
        issued = issue_challenge(db, user.id, "purge", "report", report_id, impact.impact_digest)
        return LifecyclePurgePreviewResponse(
            impact=impact,
            token=issued.token,
            expires_at=issued.expires_at,
            confirmation_name=name,
            last_successful_backup_at=last_successful_backup_at(db),
        )
    except LifecycleError as exc:
        db.rollback()
        raise _mapped(exc) from exc


@router.post("/{report_id}/purge", response_model=LifecycleMutationResponse)
def purge_report(
    report_id: UUID, payload: LifecyclePurgeRequest, user: Admin, db: Database, response: Response
) -> LifecycleMutationResponse:
    response.headers["Cache-Control"] = "no-store"
    actor_id, email = user.id, user.email
    try:
        _enabled()
        require_fresh_exact_admin(db, actor_id)
        report = _report(db, report_id)
        if payload.confirmation_name != report.name:
            raise LifecycleConfirmationNameMismatch("Confirmation must match the Report name")
        digest = challenge_impact_digest(db, payload.token, actor_id, "purge", "report", report_id)
        challenge = verify_challenge(
            db,
            payload.token,
            actor_id,
            "purge",
            "report",
            report_id,
            digest,
            email,
            payload.password,
        )
        # Password verification commits internally. Reacquire every authority and row lock.
        _enabled()
        require_fresh_exact_admin(db, actor_id)
        report = _report(db, report_id, lock=True)
        impact = _impact(db, actor_id, report, lock=True)
        if impact.impact_digest != challenge.impact_digest:
            raise LifecyclePlanDriftError("Report changed after preview; obtain a new preview")
        if payload.confirmation_name != report.name:
            raise LifecycleConfirmationNameMismatch("Confirmation must match the Report name")
        delete_report_tree(db, report)
        db.commit()
        return LifecycleMutationResponse(
            impact=impact, operation_id=get_audit_context(db).request_id
        )
    except LifecycleError as exc:
        db.rollback()
        raise _mapped(exc) from exc
    except (IntegrityError, OperationalError) as exc:
        db.rollback()
        raise HTTPException(
            409,
            detail={
                "code": "report_delete_conflict",
                "message": "The Report changed while it was being deleted; obtain a new preview",
            },
        ) from exc
