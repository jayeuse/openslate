"""Effective-access delta notices under only the affected recipient locks."""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.access.policy.scope import EffectiveAccess, effective_levels
from app.systems.access.users.eligibility import is_active_account
from app.systems.access.users.membership import sole_active_membership
from app.systems.access.users.models import User
from app.systems.platform.scheduling.models import InAppNotification, NotificationKind


@dataclass(frozen=True)
class AccessSnapshot:
    now: datetime
    users: tuple[User, ...]
    levels: dict[UUID, EffectiveAccess]


def snapshot_access(db: Session, users: Iterable[User]) -> AccessSnapshot:
    now = utc_now()
    recipients = tuple(users)
    return AccessSnapshot(
        now, recipients, {user.id: effective_levels(db, user, now=now) for user in recipients}
    )


def lock_access_recipients(db: Session, user_ids: set[UUID]) -> AccessSnapshot:
    # Source owners already hold Group/member/access/target locks. NOWAIT prevents
    # waiting in reverse order against another group or an account mutation.
    users = (
        db.scalars(
            select(User)
            .where(User.id.in_(user_ids))
            .order_by(User.id)
            .execution_options(populate_existing=True)
            .with_for_update(nowait=True)
        )
        if user_ids
        else ()
    )
    return snapshot_access(db, users)


def notify_access_changes(db: Session, before: AccessSnapshot | None) -> None:
    if before is None:
        return
    db.flush()
    for user in before.users:
        if not is_active_account(db, user, now=before.now):
            continue
        previous = before.levels[user.id]
        current = effective_levels(db, user, now=before.now)
        if (previous.unrestricted, previous.departments, previous.modules) == (
            current.unrestricted,
            current.departments,
            current.modules,
        ):
            continue
        db.add(
            InAppNotification(
                org_id=sole_active_membership(db, user.id).org_id,
                recipient_id=user.id,
                kind=NotificationKind.ACCESS_CHANGED,
                subject_type="user",
                subject_id=user.id,
            )
        )
