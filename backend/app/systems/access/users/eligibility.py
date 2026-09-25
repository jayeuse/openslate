"""Invitation-derived eligibility rules for local user profiles."""

from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.systems.access.users.models import User, UserDepartment, UserStatus
from app.systems.sandbox.departments.models import Department


def is_established_user(user: User, *, status_value: str | None = None) -> bool:
    """Return whether a profile represents an accepted or legacy account.

    A pending profile is never established, even if its timestamps are corrupted.
    Non-pending profiles with no invitation provenance are legacy accounts and
    remain eligible. A sent invitation must have been accepted before it is
    eligible for account lifecycle operations.
    """

    status = user.status if status_value is None else status_value
    if status == UserStatus.PENDING.value:
        return False
    if getattr(user, "invitation_accepted_at", None) is not None:
        return True
    return getattr(user, "invitation_sent_at", None) is None


def established_user_clause() -> ColumnElement[bool]:
    """Return the SQL predicate matching :func:`is_established_user`."""

    return and_(
        User.status != UserStatus.PENDING.value,
        or_(
            User.invitation_accepted_at.is_not(None),
            User.invitation_sent_at.is_(None),
        ),
    )


def has_active_department_membership(db: Session, user_id: UUID, department_id: UUID) -> bool:
    """Resolve current membership without trusting a caller-supplied audience claim."""

    statement = (
        select(UserDepartment.id)
        .join(User, User.id == UserDepartment.user_id)
        .join(Department, Department.id == UserDepartment.department_id)
        .where(
            UserDepartment.user_id == user_id,
            UserDepartment.department_id == department_id,
            UserDepartment.is_deleted.is_(False),
            UserDepartment.deleted_at.is_(None),
            User.status == UserStatus.ACTIVE.value,
            established_user_clause(),
            User.is_deleted.is_(False),
            User.deleted_at.is_(None),
            Department.is_deleted.is_(False),
            Department.deleted_at.is_(None),
        )
        .limit(1)
    )
    return db.scalar(statement) is not None
