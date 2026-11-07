"""Ordered, audited deletion of an archived Report, or one run, and its descendants."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.openview.reports.models import (
    Report,
    ReportRun,
    ReportRunEligibleUser,
    ReportRunRow,
)
from app.systems.openview.reports.schedule_models import ReportSchedule
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork


def delete_report_tree(db: Session, report: Report) -> None:
    """Delete a locked Report's children; the caller owns commit and rollback."""

    schedule = db.scalar(
        select(ReportSchedule).where(ReportSchedule.report_id == report.id).with_for_update()
    )
    if schedule is not None:
        db.delete(schedule)
        db.flush()

    work = list(
        db.scalars(
            select(ScheduledWork)
            .where(ScheduledWork.report_id == report.id)
            .order_by(ScheduledWork.id)
            .with_for_update()
        )
    )
    if work:
        notifications = db.scalars(
            select(InAppNotification)
            .where(InAppNotification.work_id.in_([item.id for item in work]))
            .order_by(InAppNotification.id)
            .with_for_update()
        )
        for notification in notifications:
            db.delete(notification)
        db.flush()
        for item in work:
            db.delete(item)
        db.flush()

    runs = list(
        db.scalars(
            select(ReportRun)
            .where(ReportRun.report_id == report.id)
            .order_by(ReportRun.id)
            .with_for_update()
        )
    )
    for run in runs:
        delete_report_run(db, run)
    db.delete(report)


def delete_report_run(db: Session, run: ReportRun) -> None:
    """Delete a locked run and all that references it; the caller owns commit and rollback."""

    work = db.scalar(select(ScheduledWork).where(ScheduledWork.run_id == run.id).with_for_update())
    if work is not None:
        notifications = db.scalars(
            select(InAppNotification)
            .where(InAppNotification.work_id == work.id)
            .order_by(InAppNotification.id)
            .with_for_update()
        )
        for notification in notifications:
            db.delete(notification)
        db.flush()
        db.delete(work)
        db.flush()
    eligible_users = db.scalars(
        select(ReportRunEligibleUser)
        .where(ReportRunEligibleUser.run_id == run.id)
        .order_by(ReportRunEligibleUser.user_id)
        .with_for_update()
    )
    for eligible_user in eligible_users:
        db.delete(eligible_user)
    db.flush()
    rows = db.scalars(
        select(ReportRunRow)
        .where(ReportRunRow.run_id == run.id)
        .order_by(ReportRunRow.id)
        .with_for_update()
    )
    for row in rows:
        db.delete(row)
    db.flush()
    db.delete(run)
    db.flush()
