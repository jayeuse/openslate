"""The admin-only organization part of the system status (S3, S5-C7).

Read-only: backup freshness against the schedule, failed jobs and sign-in activity of the
last 7 days, and the file storage in use, all in the bound organization. It never locks or
creates the backup policy and never returns a run list, name, backup size, path, snapshot
or failure code.
"""

from datetime import datetime, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.systems.access.users.membership import current_membership, is_platform_operator
from app.systems.access.users.models import User, UserRole
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.audit.service import _security_events_of_bound_organization
from app.systems.manage.backups.models import BackupPolicy, BackupRun
from app.systems.manage.backups.service import BackupStateError, installation_id
from app.systems.manage.health.installation import storage_used_bytes
from app.systems.manage.health.schemas import (
    BackupResult,
    OrganizationBackups,
    OrganizationStatus,
)
from app.systems.manage.jobs import registry

WINDOW = timedelta(days=7)
LATE_AFTER = timedelta(hours=1)
_RESULTS: dict[str, BackupResult] = {
    "succeeded": "verified",
    "failed": "failed",
    "interrupted": "interrupted",
}


def backup_freshness(db: Session, instance: str, now: datetime) -> OrganizationBackups:
    """The state against the schedule, the last good backup time and the last result word."""

    runs = BackupRun.installation_id == instance
    last_success_at = db.scalar(
        select(BackupRun.finished_at)
        .where(runs, BackupRun.state == "succeeded")
        .order_by(BackupRun.finished_at.desc())
        .limit(1)
    )
    last_state = db.scalar(
        select(BackupRun.state)
        .where(runs, BackupRun.finished_at.is_not(None))
        .order_by(BackupRun.finished_at.desc(), BackupRun.id.desc())
        .limit(1)
    )
    last_result = _RESULTS.get(last_state) if last_state is not None else None
    policy = db.scalar(select(BackupPolicy))
    if policy is None or policy.schedule == "disabled" or policy.installation_id != instance:
        state = "no_schedule"
    elif last_success_at is None:
        state = "never_backed_up"
    else:
        # The stored due time advances only when the runner claims a run, so a dead
        # runner leaves it in the past and the backups show late.
        due = (
            policy.next_due_at
            if policy.next_due_at is not None and policy.next_due_at <= now
            else db.scalar(
                select(func.max(BackupRun.scheduled_for)).where(
                    runs, BackupRun.scheduled_for <= now
                )
            )
        )
        late = due is not None and now >= due + LATE_AFTER and last_success_at < due
        state = "late" if late else "on_time"
    return OrganizationBackups(
        state=state, last_success_at=last_success_at, last_result=last_result
    )


def _failed_jobs(db: Session, person: User, instance: str, since: datetime) -> int:
    """Failed jobs of the kinds this admin sees in Manage → Jobs, in the bound organization."""

    _statement, columns = registry.jobs_query(instance)
    count = select(func.count()).where(
        columns.state == "failed",
        columns.effective_at >= since,
        or_(columns.org_id == bound_organization_column(), columns.kind == "backup"),
    )
    if not is_platform_operator(db, person.id):
        count = count.where(columns.kind != "backup")
    return int(db.scalar(count) or 0)


def _sign_in_counts(db: Session, since: datetime) -> tuple[int, int]:
    """Failed sign-ins and lockouts of the bound organization, as Access → Security shows."""

    rows = db.execute(
        select(SecurityEvent.event_type, func.count())
        .where(
            SecurityEvent.event_type.in_(("identity.sign_in_failure", "identity.lockout")),
            SecurityEvent.occurred_at >= since,
            _security_events_of_bound_organization(),
        )
        .group_by(SecurityEvent.event_type)
    ).all()
    counts = {str(event_type): int(count) for event_type, count in rows}
    return counts.get("identity.sign_in_failure", 0), counts.get("identity.lockout", 0)


def organization_status(
    db: Session, person: User, *, now: datetime | None = None
) -> OrganizationStatus | None:
    """The part for an admin of the bound organization; ``None`` for everyone else, never a 403."""

    membership = current_membership(db, person)
    if membership is None or membership.role != UserRole.ADMIN.value:
        return None
    current = now or utc_now()
    since = current - WINDOW
    failed_jobs: int | None
    try:
        instance = installation_id(db)
    except BackupStateError:
        backups = OrganizationBackups(state="unknown", last_success_at=None, last_result=None)
        failed_jobs = None
    else:
        backups = backup_freshness(db, instance, current)
        failed_jobs = _failed_jobs(db, person, instance, since)
    failed_sign_ins, lockouts = _sign_in_counts(db, since)
    return OrganizationStatus(
        since=since,
        backups=backups,
        failed_jobs=failed_jobs,
        failed_sign_ins=failed_sign_ins,
        lockouts=lockouts,
        storage_used_bytes=storage_used_bytes(db),
    )
