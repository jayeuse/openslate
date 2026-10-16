"""Serialize pending-upload admission without blocking cleanup of existing inventory."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.platform.files.access import error
from app.systems.platform.files.models import File

PENDING_UPLOAD_COUNT = 100
# 100 uploads of at most 10 MiB (D18) never reach 1 GiB; 512 MiB keeps both caps live.
PENDING_UPLOAD_BYTES = 512 * 1024 * 1024
LOGO_CHARGE = 2 * 1024 * 1024
RESERVATION_TTL = timedelta(hours=24)
# Stable application advisory-lock namespace for file admission.
QUOTA_LOCK = 57168423129478011


def lock_quota(db: Session) -> None:
    # Always before ancestor/file locks when a transition can increase occupancy.
    acquired = db.scalar(select(func.pg_try_advisory_xact_lock(QUOTA_LOCK)))
    if not acquired:
        raise error("file_quota_busy", "File admission is busy; retry shortly", 503)


def require_capacity(
    db: Session, purpose: str, expected_size: int, *, creator_id: UUID
) -> None:
    count, size = db.execute(
        select(
            func.count(File.id),
            func.coalesce(
                func.sum(
                    case(
                        (File.purpose.in_(("workspace_logo", "user_avatar")), LOGO_CHARGE),
                        else_=File.expected_size,
                    )
                ),
                0,
            ),
        ).where(
            File.state.in_(("awaiting_upload", "uploading")),
            # Pending capacity is counted per organization. Avatars are account files,
            # so each account has its own avatar budget and cannot exhaust another's.
            and_(File.org_id.is_(None), File.creator_id == creator_id)
            if purpose == "user_avatar"
            else File.org_id == bound_organization_column(),
        )
    ).one()
    charge = LOGO_CHARGE if purpose in {"workspace_logo", "user_avatar"} else expected_size
    if count >= PENDING_UPLOAD_COUNT or size + charge > PENDING_UPLOAD_BYTES:
        raise error("file_uploads_full", "Pending upload capacity is full", 409)


def require_live_reservation(file: File, *, now: datetime | None = None) -> None:
    timestamp = now or datetime.now(UTC)
    if file.created_at + RESERVATION_TTL <= timestamp:
        raise error(
            "file_reservation_expired", "File reservation expired; create a new upload", 409
        )
