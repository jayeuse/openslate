"""Shared account-expiry and identity-kind decisions for local authentication."""

from datetime import UTC, datetime

from app.core.base_model import utc_now
from app.systems.access.users.models import IdentityKind, User


def is_identity_eligible(user: User, *, now: datetime | None = None) -> bool:
    """Return whether a non-deleted account has not reached its expiry boundary."""

    timestamp = now or utc_now()
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=UTC)
    expires_at = user.expires_at
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    return not user.is_deleted and (expires_at is None or expires_at > timestamp)


def is_internal_identity(user: User) -> bool:
    """Return whether this persisted identity can hold the administrator role."""

    return user.identity_kind == IdentityKind.INTERNAL.value
