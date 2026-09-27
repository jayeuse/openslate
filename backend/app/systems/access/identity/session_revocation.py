"""Idempotent local identity-session revocation use cases."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.access.identity.models import IdentitySession


def _now(now: datetime | None = None) -> datetime:
    timestamp = now or utc_now()
    return timestamp if timestamp.tzinfo is not None else timestamp.replace(tzinfo=UTC)


def revoke_session(
    db: Session, session_id: UUID, user_id: UUID, *, now: datetime | None = None
) -> bool:
    """Revoke one active session, returning whether it changed state."""

    session = db.get(IdentitySession, session_id, with_for_update=True)
    if session is None or session.user_id != user_id or session.revoked_at is not None:
        return False
    timestamp = _now(now)
    session.revoked_at = timestamp
    _schedule_provider_signout(session, timestamp)
    return True


def revoke_user_sessions(
    db: Session, user_id: UUID, *, except_session_id: UUID | None, now: datetime | None = None
) -> int:
    """Revoke active sessions other than an optional preserved session."""

    timestamp = _now(now)
    changed = 0
    for session in db.scalars(
        select(IdentitySession).where(
            IdentitySession.user_id == user_id, IdentitySession.revoked_at.is_(None)
        )
    ):
        if session.id != except_session_id and session.revoked_at is None:
            session.revoked_at = timestamp
            _schedule_provider_signout(session, timestamp)
            changed += 1
    return changed


def _schedule_provider_signout(session: IdentitySession, timestamp: datetime) -> None:
    if session.provider_session_id is None or not session.provider_refresh_token_encrypted:
        return
    session.provider_signout_pending_at = timestamp
    session.provider_signout_next_attempt_at = timestamp
    session.provider_signout_attempts = 0
    session.provider_signout_completed_at = None
