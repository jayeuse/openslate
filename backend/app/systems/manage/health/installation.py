"""Block 4 for the installation owner and the organization file storage sum (S5-C6, S5-C7)."""

from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.systems.access.users.membership import is_platform_operator
from app.systems.access.users.models import User
from app.systems.manage.backups.models import BackupPolicy
from app.systems.manage.health.models import SystemHealthSample, SystemHealthSignal
from app.systems.manage.health.schemas import (
    InstallationStatus,
    InstallationWorker,
    WorkerKey,
    WorkerState,
)
from app.systems.platform.files.models import File

# A sample's database size is current for 10 minutes.
SIZE_FRESH = timedelta(minutes=10)
# In-app workers beat at most once a minute; the backup runner reports every few minutes.
RUNNING_WITHIN = timedelta(minutes=3)
BACKUP_RUNNER_WITHIN = timedelta(minutes=5)
SIGNAL_WORKERS: tuple[WorkerKey, ...] = (
    "record_triggers", "report_scheduling", "comms_jobs", "provider_signout",
)


def _worker(
    key: WorkerKey, last_seen_at: datetime | None, now: datetime, within: timedelta
) -> InstallationWorker:
    state: WorkerState = (
        "never_seen"
        if last_seen_at is None
        else "running"
        if now - last_seen_at <= within
        else "not_seen"
    )
    return InstallationWorker(key=key, state=state, last_seen_at=last_seen_at)


def installation_status(
    db: Session, person: User, *, now: datetime | None = None
) -> InstallationStatus | None:
    """The part for the installation owner; ``None`` for everyone else, never a 403."""

    if not is_platform_operator(db, person.id):
        return None
    current = now or utc_now()
    sample = db.execute(
        select(SystemHealthSample.database_bytes, SystemHealthSample.sampled_at)
        .where(
            SystemHealthSample.database_bytes.is_not(None),
            SystemHealthSample.sampled_at >= current - SIZE_FRESH,
        )
        .order_by(SystemHealthSample.sampled_at.desc())
        .limit(1)
    ).first()
    seen = dict(
        db.execute(
            select(SystemHealthSignal.key, SystemHealthSignal.last_seen_at).where(
                SystemHealthSignal.key.in_(SIGNAL_WORKERS)
            )
        )
        .tuples()
        .all()
    )
    runner_seen = db.scalar(select(BackupPolicy.runner_last_seen_at))
    return InstallationStatus(
        database_bytes=sample[0] if sample is not None else None,
        database_measured_at=sample[1] if sample is not None else None,
        workers=[
            *(_worker(key, seen.get(key), current, RUNNING_WITHIN) for key in SIGNAL_WORKERS),
            _worker("backup_runner", runner_seen, current, BACKUP_RUNNER_WITHIN),
        ],
    )


def storage_used_bytes(db: Session, org_id: UUID | None = None) -> int | None:
    """Bytes of an organization's stored files, trash included until purged.

    Without ``org_id`` it sums the bound organization. Uploads that never finished,
    rejected files and avatars do not count. ``None`` when the sum cannot be read.
    """

    try:
        with db.begin_nested():
            total = db.scalar(
                select(func.coalesce(func.sum(File.actual_size), 0)).where(
                    File.org_id == (org_id if org_id is not None else bound_organization_column()),
                    File.state.in_(("ready", "deleting")),
                    File.actual_size.is_not(None),
                )
            )
    except SQLAlchemyError:
        return None
    return int(total or 0)
