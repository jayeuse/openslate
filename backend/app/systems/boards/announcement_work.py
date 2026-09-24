"""Board-owned coordination of announcement source changes with durable work."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.boards.announcement_models import BoardAnnouncement
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)


def cancel_announcement_work(db: Session, item: BoardAnnouncement) -> None:
    """Invalidate outstanding work after the caller locked Board then announcement."""

    outstanding = db.scalars(
        select(ScheduledWork)
        .where(
            ScheduledWork.kind == WorkKind.ANNOUNCEMENT_PUBLISH,
            ScheduledWork.announcement_id == item.id,
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


def delete_announcement_work(db: Session, item: BoardAnnouncement) -> None:
    """Delete all dependent references before the caller deletes immutable revisions."""

    rows = list(
        db.scalars(
            select(ScheduledWork)
            .where(
                ScheduledWork.kind == WorkKind.ANNOUNCEMENT_PUBLISH,
                ScheduledWork.announcement_id == item.id,
            )
            .order_by(ScheduledWork.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    if not rows:
        return
    notifications = db.scalars(
        select(InAppNotification)
        .where(InAppNotification.work_id.in_([work.id for work in rows]))
        .order_by(InAppNotification.id)
        .with_for_update()
    )
    for notification in notifications:
        db.delete(notification)
    db.flush()
    for work in rows:
        db.delete(work)
    db.flush()
