"""Bounded scheduled Report execution with current owner-audience rechecks.

The process-local worker invokes this coordinator after application startup;
each attempt rechecks eligibility before creating a run or notification.
"""

import logging
from datetime import datetime
from uuid import UUID

from sqlalchemy import Engine, select
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.session import AuditSession
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.openview.reports.audience import capture_run_eligible_users
from app.systems.openview.reports.models import Report, ReportRun, ReportRunRow
from app.systems.openview.reports.run_service import (
    ReportSnapshot,
    capture_report_snapshot,
    validate_report_recipe,
)
from app.systems.openview.reports.schemas import ReportRecipe
from app.systems.platform.scheduling.materializer import materialize_due_schedules
from app.systems.platform.scheduling.models import ScheduledWork, WorkKind, WorkState
from app.systems.platform.scheduling.service import (
    MAX_CLAIM_BATCH,
    WorkClaim,
    _eligible_owner,
    _locked_claim,
    _utc_instant,
    claim_due_work,
    complete_report_work,
    fail_report_work,
)

logger = logging.getLogger(__name__)


def _session(engine: Engine) -> AuditSession:
    db = AuditSession(engine)
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        request_id=uuid7(),
        request_method="SCHEDULE",
        request_path="/internal/reports/scheduler",
    )
    return db


def _current(now: datetime | None) -> datetime:
    return _utc_instant(now or utc_now())


def _fail_claim(engine: Engine, claim: WorkClaim, *, now: datetime | None) -> None:
    with _session(engine) as db:
        if fail_report_work(db, claim, now=_current(now)):
            db.commit()


def _finalize_claim(
    engine: Engine,
    claim: WorkClaim,
    snapshot: ReportSnapshot | None,
    *,
    now: datetime | None,
) -> UUID | None:
    """Lock Report before work; commit output, state and notification together."""

    with _session(engine) as db:
        report_id = db.scalar(
            select(ScheduledWork.report_id).where(
                ScheduledWork.id == claim.id, ScheduledWork.kind == WorkKind.REPORT_RUN
            )
        )
        if report_id is None:
            return None
        report = db.scalar(
            select(Report)
            .where(Report.id == report_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        owner = _eligible_owner(db, report, lock=True) if report is not None else None
        work = _locked_claim(db, claim, _current(now))
        if work is None or work.report_id != report_id:
            return None
        if owner is None or report is None:
            work.state = WorkState.CANCELED
            work.failure_code = "source_unavailable"
            work.lease_token = None
            work.lease_expires_at = None
            db.commit()
            return None
        if snapshot is None or (
            snapshot.report_id != report.id
            or snapshot.module_id != report.module_id
            or snapshot.recipe_revision != report.revision
            or snapshot.recipe != report.recipe
        ):
            fail_report_work(db, claim, now=_current(now))
            db.commit()
            return None

        validate_report_recipe(db, report.module_id, ReportRecipe.model_validate(report.recipe))
        existing = db.scalar(
            select(ReportRun).where(
                ReportRun.report_id == report.id,
                ReportRun.idempotency_key == work.id,
            )
        )
        if existing is not None:
            # A successful scheduled run and work state commit atomically. An
            # already-present run while work is still running is therefore a
            # conflicting output, not something this lease may deliver.
            fail_report_work(db, claim, now=_current(now))
            db.commit()
            return None

        run = ReportRun(
            report_id=report.id,
            module_id=snapshot.module_id,
            idempotency_key=work.id,
            recipe_revision=snapshot.recipe_revision,
            recipe=snapshot.recipe,
            headings=snapshot.headings,
            row_count=len(snapshot.rows),
            csv_bytes=snapshot.csv_bytes,
        )
        db.add(run)
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
        db.flush()
        if not complete_report_work(db, claim, run.id, now=_current(now)):
            db.rollback()
            return None
        db.commit()
        return run.id


def execute_report_claim(
    engine: Engine, claim: WorkClaim, *, now: datetime | None = None
) -> UUID | None:
    """Capture outside write transactions, then recheck authorization and lease."""

    with _session(engine) as db:
        work = db.get(ScheduledWork, claim.id)
        report = (
            db.get(Report, work.report_id)
            if work is not None and work.kind == WorkKind.REPORT_RUN and work.report_id is not None
            else None
        )
        owner = _eligible_owner(db, report, lock=False) if report is not None else None
        report_id = report.id if report is not None else None
        owner_id = owner.id if owner is not None else None
    if report_id is None or owner_id is None:
        return _finalize_claim(engine, claim, None, now=now)

    try:
        snapshot = capture_report_snapshot(engine, report_id, owner_id)
        return _finalize_claim(engine, claim, snapshot, now=now)
    except Exception:
        # This is the worker process boundary. A failed capture or final write
        # has rolled back before a separate, lease-checked retry transition.
        logger.warning("Scheduled Report attempt failed; applying bounded retry")
        _fail_claim(engine, claim, now=now)
        return None


def execute_due_report_runs(
    engine: Engine, *, now: datetime | None = None, limit: int = MAX_CLAIM_BATCH
) -> list[UUID]:
    """Materialize, claim, and process one bounded batch with separate commits."""

    current = _current(now)
    if not 1 <= limit <= MAX_CLAIM_BATCH:
        raise ValueError("Scheduled Report batch limit is out of range")
    with _session(engine) as db:
        materialize_due_schedules(db, now=current, limit=limit)
        db.commit()
    with _session(engine) as db:
        claims = claim_due_work(db, now=current, limit=limit)
        db.commit()
    completed: list[UUID] = []
    for claim in claims:
        run_id = execute_report_claim(engine, claim, now=now)
        if run_id is not None:
            completed.append(run_id)
    return completed
