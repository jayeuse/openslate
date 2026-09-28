"""Shared account-expiry decisions for local authentication."""

from datetime import UTC, datetime

from sqlalchemy import and_, or_
from sqlalchemy.sql.elements import ColumnElement

from app.core.base_model import utc_now
from app.systems.access.users.models import User


def is_identity_eligible(user: User, *, now: datetime | None = None) -> bool:
    """Return whether a non-deleted account has not reached its expiry boundary."""

    timestamp = now or utc_now()
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=UTC)
    expires_at = user.expires_at
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    return not user.is_deleted and (expires_at is None or expires_at > timestamp)


def identity_eligible_clause(*, now: datetime | None = None) -> ColumnElement[bool]:
    """SQL equivalent of the account-expiry boundary for recipient queries."""

    timestamp = now or utc_now()
    return and_(
        User.is_deleted.is_(False),
        or_(User.expires_at.is_(None), User.expires_at > timestamp),
    )
