"""Bounded terminal-session cleanup with an atomic maintenance proof."""

from datetime import UTC, datetime, timedelta
from typing import cast

from sqlalchemy import Select, func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.identity.models import IdentitySession
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.workspace.models import WorkspaceProfile

_BATCH_LIMIT = 1000
_LOCK_KEY = 0x4F535253455353


def _retention_statement(cutoff: datetime) -> Select[tuple[IdentitySession]]:
    anchor = func.greatest(
        func.coalesce(IdentitySession.revoked_at, IdentitySession.expires_at),
        func.coalesce(
            IdentitySession.provider_signout_completed_at,
            IdentitySession.revoked_at,
            IdentitySession.expires_at,
        ),
    )
    return (
        select(IdentitySession)
        .where(
            IdentitySession.provider_signout_pending_at.is_(None),
            IdentitySession.provider_signout_next_attempt_at.is_(None),
            or_(
                IdentitySession.provider_signout_attempts == 0,
                IdentitySession.provider_signout_completed_at.is_not(None),
            ),
            anchor < cutoff,
        )
        .order_by(anchor, IdentitySession.id)
        .limit(_BATCH_LIMIT)
        .execution_options(populate_existing=True)
        .with_for_update(of=IdentitySession, skip_locked=True)
    )


def retain_terminal_sessions(db: Session) -> int:
    """Own one maintenance transaction; delete instances and proof atomically."""
    try:
        if not db.scalar(select(func.pg_try_advisory_xact_lock(_LOCK_KEY))):
            db.rollback()
            return 0
        profile = db.scalar(
            select(WorkspaceProfile)
            .where(WorkspaceProfile.singleton_key.is_(True))
            .execution_options(populate_existing=True)
            .with_for_update(read=True, of=WorkspaceProfile)
        )
        if profile is None:
            raise SQLAlchemyError("Workspace retention policy is unavailable")
        retention_days = profile.session_retention_days
        as_of = cast(datetime, db.scalar(select(func.now()))).astimezone(UTC)
        cutoff = as_of - timedelta(days=retention_days)
        rows = list(db.scalars(_retention_statement(cutoff)))
        if not rows:
            db.rollback()
            return 0
        for row in rows:
            db.delete(row)
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="security.retention",
                outcome=SecurityEventOutcome.SUCCESS,
                source="identity.session_retention",
                operation_id=uuid7(),
                occurred_at=as_of,
                metadata={
                    "scope": "identity_sessions",
                    "retention_days": retention_days,
                    "batch_limit": _BATCH_LIMIT,
                    "as_of": as_of.isoformat(),
                    "cutoff": cutoff.isoformat(),
                    "deleted_sessions": len(rows),
                },
            ),
        )
        db.commit()
        return len(rows)
    except SQLAlchemyError:
        db.rollback()
        raise
