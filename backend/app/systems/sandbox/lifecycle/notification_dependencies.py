"""Notifications about the records a purge deletes for good (decision D6)."""

from collections.abc import Callable, Sequence
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.platform.scheduling.models import InAppNotification
from app.systems.sandbox.lifecycle.department_board_dependencies import dependency_state
from app.systems.sandbox.lifecycle.schemas import LifecycleRowState


def load_record_notification_purge_dependencies(
    db: Session, record_ids: Sequence[UUID], fingerprint: Callable[[object], str]
) -> tuple[list[LifecycleRowState], tuple[UUID, ...]]:
    """Inventory every notification whose subject is one of the purged records.

    ``subject_id`` has no foreign key, so nothing else removes them; they join the
    plan, its digest and its audited deletion like the other purged rows.
    """
    if not record_ids:
        return [], ()
    notifications = db.scalars(
        select(InAppNotification)
        .where(
            InAppNotification.org_id == bound_organization_column(),
            InAppNotification.subject_type == "record",
            InAppNotification.subject_id.in_(record_ids),
        )
        .order_by(InAppNotification.id)
    ).all()
    rows = [
        dependency_state("in_app_notifications", notification, fingerprint)
        for notification in notifications
    ]
    return rows, tuple(notification.id for notification in notifications)
