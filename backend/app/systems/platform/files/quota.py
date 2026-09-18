"""Serialize quarantine admission without blocking cleanup of existing inventory."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.systems.platform.files.access import error
from app.systems.platform.files.models import File

QUARANTINE_COUNT = 100
QUARANTINE_BYTES = 1024 * 1024 * 1024
LOGO_CHARGE = 2 * 1024 * 1024
RESERVATION_TTL = timedelta(hours=24)
# Stable application namespace, distinct from the worker leadership lock.
QUOTA_LOCK = 57168423129478011


def lock_quota(db: Session) -> None:
    # Always before ancestor/file locks when a transition can increase occupancy.
    acquired = db.scalar(select(func.pg_try_advisory_xact_lock(QUOTA_LOCK)))
    if not acquired:
        raise error("file_quota_busy", "File admission is busy; retry shortly", 503)


def require_capacity(db: Session, purpose: str, expected_size: int) -> None:
    count, size = db.execute(
        select(
            func.count(File.id),
            func.coalesce(
                func.sum(
                    case(
                        (File.purpose == "workspace_logo", LOGO_CHARGE),
                        else_=File.expected_size,
                    )
                ),
                0,
            ),
        ).where(File.state.not_in(("ready", "purged")))
    ).one()
    charge = LOGO_CHARGE if purpose == "workspace_logo" else expected_size
    if count >= QUARANTINE_COUNT or size + charge > QUARANTINE_BYTES:
        raise error("file_quarantine_full", "Pending file capacity is full", 409)


def require_live_reservation(file: File, *, now: datetime | None = None) -> None:
    timestamp = now or datetime.now(UTC)
    if file.created_at + RESERVATION_TTL <= timestamp:
        raise error(
            "file_reservation_expired", "File reservation expired; create a new upload", 409
        )
