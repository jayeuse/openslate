"""Invitation-derived eligibility rules for local user profiles."""

from sqlalchemy import and_, or_
from sqlalchemy.sql.elements import ColumnElement

from app.systems.access.users.models import User, UserStatus


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
