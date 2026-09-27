"""Report recipe and retained-run dependencies for physical source purges."""

import hashlib
from collections.abc import Callable
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.systems.openview.reports.models import Report, ReportRun, ReportRunRow
from app.systems.sandbox.lifecycle.planning_scope import row_state
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleRowState,
)


def load_report_purge_dependencies(
    db: Session,
    module_ids: list[UUID],
    record_ids: list[UUID],
    fingerprint: Callable[[object], str],
) -> tuple[list[LifecycleRowState], list[LifecycleBlocker], dict[str, tuple[UUID, ...]]]:
    """Block deletion of every recipe or frozen row touched by a purge scope."""

    report_rows = (
        list(
            db.scalars(
                select(ReportRunRow)
                .where(ReportRunRow.record_id.in_(record_ids))
                .order_by(ReportRunRow.id)
            )
        )
        if record_ids
        else []
    )
    referenced_run_ids = [row.run_id for row in report_rows]
    run_filters = []
    if module_ids:
        run_filters.append(ReportRun.module_id.in_(module_ids))
    if referenced_run_ids:
        run_filters.append(ReportRun.id.in_(referenced_run_ids))
    report_runs = (
        list(db.scalars(select(ReportRun).where(or_(*run_filters)).order_by(ReportRun.id)))
        if run_filters
        else []
    )
    referenced_report_ids = [run.report_id for run in report_runs]
    report_filters = []
    if module_ids:
        report_filters.append(Report.module_id.in_(module_ids))
    if referenced_report_ids:
        report_filters.append(Report.id.in_(referenced_report_ids))
    reports = (
        list(db.scalars(select(Report).where(or_(*report_filters)).order_by(Report.id)))
        if report_filters
        else []
    )

    rows: list[LifecycleRowState] = []
    blockers: list[LifecycleBlocker] = []
    for report in reports:
        state = row_state("reports", report)
        state.state_fingerprint = fingerprint(
            {
                key: getattr(report, key)
                for key in (
                    "owner_id",
                    "module_id",
                    "name",
                    "subtitle",
                    "audience_kind",
                    "audience_user_id",
                    "revision",
                    "recipe",
                )
            }
        )
        rows.append(state)
        if report.module_id in module_ids:
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.PURGE_REPORT_DEPENDENCY,
                    entity_type="reports",
                    entity_id=report.id,
                    detail=(
                        "Permanently delete this Report and its retained runs before purging "
                        "the source Module; archiving does not release the dependency"
                    ),
                    conflicting_entity_type="modules",
                    conflicting_entity_id=report.module_id,
                    module_id=report.module_id,
                )
            )
    runs_by_id = {run.id: run for run in report_runs}
    for run in report_runs:
        state = row_state("report_runs", run)
        state.state_fingerprint = fingerprint(
            {
                "report_id": run.report_id,
                "module_id": run.module_id,
                "idempotency_key": run.idempotency_key,
                "recipe_revision": run.recipe_revision,
                "recipe": run.recipe,
                "headings": run.headings,
                "row_count": run.row_count,
                "csv_sha256": hashlib.sha256(run.csv_bytes).hexdigest(),
            }
        )
        rows.append(state)
        if run.module_id in module_ids:
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.PURGE_REPORT_RUN_DEPENDENCY,
                    entity_type="report_runs",
                    entity_id=run.id,
                    detail=(
                        "Permanently delete the parent Report and retained run before purging "
                        "the source Module"
                    ),
                    conflicting_entity_type="reports",
                    conflicting_entity_id=run.report_id,
                    module_id=run.module_id,
                )
            )
    for report_row in report_rows:
        state = row_state("report_run_rows", report_row)
        state.state_fingerprint = fingerprint(
            {key: getattr(report_row, key) for key in ("run_id", "record_id", "position", "cells")}
        )
        rows.append(state)
        parent_run = runs_by_id.get(report_row.run_id)
        blockers.append(
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_REPORT_RUN_DEPENDENCY,
                entity_type="report_run_rows",
                entity_id=report_row.id,
                detail=(
                    "Permanently delete the parent Report and retained run before purging "
                    "this source Record"
                ),
                conflicting_entity_type="reports" if parent_run is not None else "report_runs",
                conflicting_entity_id=(
                    parent_run.report_id if parent_run is not None else report_row.run_id
                ),
            )
        )
    return (
        rows,
        blockers,
        {
            "reports": tuple(report.id for report in reports),
            "report_runs": tuple(run.id for run in report_runs),
            "report_run_rows": tuple(row.id for row in report_rows),
        },
    )
