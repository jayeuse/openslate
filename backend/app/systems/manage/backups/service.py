"""Installation-fenced policy, claim, recovery and observation coordination.

Mutation helpers never commit; routes and the retained-connection bridge own commits.
"""

import hashlib
import re
from datetime import UTC, datetime, time, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.core.config import get_instance_settings, get_settings
from app.systems.manage.backups.models import BackupPolicy, BackupRun, UpdateStatus
from app.systems.manage.backups.schemas import (
    VERSION_PATTERN,
    BackupPolicyResponse,
    BackupRunResponse,
    BackupStatusResponse,
    ClaimResponse,
    ExpireCommand,
    OutcomeCommand,
    ReleaseCommand,
    RunnerResponse,
    VersionResponse,
)
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.scheduling.materializer import next_due_after


class BackupStateError(RuntimeError):
    """A safe code at the public or private metadata boundary."""


def installation_id(db: Session) -> str:
    """Use admitted server configuration, fenced by the connected database identity."""
    cluster = db.scalar(select(func.current_setting("cluster_name", True)))
    expected = (
        cluster
        if get_settings().environment == "test"
        else get_instance_settings().open_slate_instance_id
    )
    if not isinstance(cluster, str) or not cluster or cluster != expected:
        raise BackupStateError("backup_identity_conflict")
    return cluster


def workspace(db: Session, *, lock: bool = False) -> WorkspaceProfile:
    statement = select(WorkspaceProfile).where(WorkspaceProfile.singleton_key.is_(True))
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    row = db.scalar(statement)
    if row is None:
        raise BackupStateError("backup_unavailable")
    return row


def lock_policy(db: Session, instance: str, *, now: datetime | None = None) -> BackupPolicy:
    """Serialize absent-singleton creation as well as all policy/queue writers."""
    profile = workspace(db, lock=True)
    policy = db.scalar(
        select(BackupPolicy).with_for_update().execution_options(populate_existing=True)
    )
    if policy is None:
        policy = BackupPolicy(
            installation_id=instance,
            timezone=profile.timezone,
            schedule="disabled",
            retention_days=30,
            revision=1,
        )
        db.add(policy)
        db.flush()
    return policy


def future_due(schedule: str, timezone: str, now: datetime) -> datetime | None:
    if schedule == "disabled":
        return None
    return next_due_after(
        cadence=schedule,
        timezone_name=timezone,
        local_time=time(2),
        weekday=6 if schedule == "weekly" else None,
        month_day=None,
        after=now.astimezone(UTC),
    )


def policy_response(
    db: Session, instance: str, *, now: datetime | None = None
) -> BackupPolicyResponse:
    profile = workspace(db)
    policy = db.scalar(select(BackupPolicy))
    if policy is None:
        return BackupPolicyResponse(
            schedule="disabled",
            retention_days=30,
            revision=1,
            timezone=profile.timezone,
            next_due_at=None,
            adopted=True,
        )
    adopted = policy.installation_id == instance
    due = policy.next_due_at if adopted else None
    if adopted and policy.timezone != profile.timezone:
        due = future_due(policy.schedule, profile.timezone, now or utc_now())
    return BackupPolicyResponse.model_validate(
        {
            "schedule": policy.schedule,
            "retention_days": policy.retention_days,
            "revision": policy.revision,
            "timezone": profile.timezone,
            "next_due_at": due,
            "adopted": adopted,
        }
    )


def run_response(run: BackupRun, instance: str) -> BackupRunResponse:
    values = {
        field: getattr(run, field)
        for field in BackupRunResponse.model_fields
        if field != "installation"
    }
    values["installation"] = "current" if run.installation_id == instance else "previous"
    return BackupRunResponse.model_validate(values)


def claim_response(run: BackupRun, instance: str) -> ClaimResponse:
    return ClaimResponse.model_validate(
        {
            "run": run_response(run, instance),
            "claim_id": run.claim_id,
            "installation_id": run.installation_id,
            "scheduled_for": run.scheduled_for,
            "claimed_schedule": run.claimed_schedule,
            "claimed_retention_days": run.claimed_retention_days,
        }
    )


def unresolved_run(db: Session, instance: str) -> BackupRun | None:
    return db.scalar(
        select(BackupRun).where(
            BackupRun.installation_id == instance,
            BackupRun.started_at.is_not(None),
            BackupRun.reconciled_at.is_(None),
        )
    )


def queued_count(db: Session, instance: str) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(BackupRun)
            .where(
                BackupRun.installation_id == instance,
                BackupRun.state == "queued",
                BackupRun.started_at.is_(None),
            )
        )
        or 0
    )


def status_response(
    db: Session, instance: str, *, now: datetime | None = None
) -> BackupStatusResponse:
    current = now or utc_now()
    policy, active = policy_response(db, instance, now=current), unresolved_run(db, instance)
    stored = db.scalar(select(BackupPolicy))
    seen = stored.runner_last_seen_at if stored is not None and policy.adopted else None
    runner = RunnerResponse(state="unknown", last_seen_at=seen)
    if not policy.adopted:
        runner.state = "adoption_required"
    elif active is not None:
        runner.state = (
            "recovery_required"
            if active.state != "running"
            else (
                "available"
                if seen is not None and current - seen <= timedelta(minutes=5)
                else "recovery_required"
            )
        )
    elif seen is not None:
        runner.state = "available" if current - seen <= timedelta(minutes=5) else "stale"
    return BackupStatusResponse(
        policy=policy,
        runner=runner,
        active_run=run_response(active, instance) if active else None,
        queued_count=queued_count(db, instance),
    )


def queue_manual(db: Session, instance: str, actor: UUID, name: str, key: str) -> BackupRun:
    policy = lock_policy(db, instance)
    digest = hashlib.sha256(key.encode("ascii")).hexdigest()
    existing = db.scalar(
        select(BackupRun).where(
            BackupRun.installation_id == instance,
            BackupRun.requester_id == actor,
            BackupRun.idempotency_hash == digest,
        )
    )
    if existing is not None:
        if existing.name != name:
            raise BackupStateError("backup_idempotency_conflict")
        return existing
    run = BackupRun(
        installation_id=instance,
        name=name,
        provenance="manual",
        requester_id=actor,
        idempotency_hash=digest,
        schedule=policy.schedule,
        retention_days=policy.retention_days,
        requested_at=utc_now(),
        performed_by=actor,
    )
    db.add(run)
    db.flush()
    return run


def exact_claim(
    db: Session, instance: str, claim_id: UUID, run_id: UUID | None = None, *, lock: bool = False
) -> BackupRun | None:
    statement = select(BackupRun).where(BackupRun.claim_id == claim_id)
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    run = db.scalar(statement)
    if run is not None and (
        run.installation_id != instance or (run_id is not None and run.id != run_id)
    ):
        raise BackupStateError("backup_identity_conflict")
    return run


def claim_run(
    db: Session, instance: str, claim_id: UUID, *, now: datetime | None = None
) -> BackupRun | None:
    current = now or utc_now()
    policy = lock_policy(db, instance)
    prior = exact_claim(db, instance, claim_id)
    if prior is not None:
        return prior
    if unresolved_run(db, instance) is not None:
        raise BackupStateError("backup_recovery_required")
    if policy.installation_id != instance:
        raise BackupStateError("backup_adoption_required")
    profile = workspace(db)
    if policy.timezone != profile.timezone or (
        policy.schedule != "disabled" and policy.next_due_at is None
    ):
        policy.timezone = profile.timezone
        policy.next_due_at = future_due(policy.schedule, profile.timezone, current)
    if policy.next_due_at is not None and policy.next_due_at <= current:
        occurrence = policy.next_due_at
        if (
            db.scalar(
                select(BackupRun.id).where(
                    BackupRun.installation_id == instance, BackupRun.scheduled_for == occurrence
                )
            )
            is None
        ):
            db.add(
                BackupRun(
                    installation_id=instance,
                    name="Scheduled backup",
                    provenance="scheduled",
                    schedule=policy.schedule,
                    retention_days=policy.retention_days,
                    requested_at=current,
                    scheduled_for=occurrence,
                )
            )
        policy.next_due_at = future_due(policy.schedule, policy.timezone, current)
        db.flush()
    policy.runner_last_seen_at = current
    run = db.scalar(
        select(BackupRun)
        .where(
            BackupRun.installation_id == instance,
            BackupRun.state == "queued",
            BackupRun.started_at.is_(None),
        )
        .order_by(BackupRun.requested_at, BackupRun.id)
        .with_for_update(skip_locked=True)
        .limit(1)
    )
    if run is not None:
        run.claim_id, run.started_at, run.state = claim_id, current, "running"
        run.claimed_schedule, run.claimed_retention_days = policy.schedule, policy.retention_days
        db.flush()
    return run


def record_outcome(db: Session, instance: str, command: OutcomeCommand) -> BackupRun:
    run = exact_claim(db, instance, command.claim_id, command.run_id, lock=True)
    if run is None or command.installation_id != instance:
        raise BackupStateError("backup_identity_conflict")
    fields = (
        "state",
        "finished_at",
        "reconciled_at",
        "snapshot_id",
        "manifest_sha256",
        "verified_at",
        "failure_code",
    )
    if run.reconciled_at is not None:
        if any(getattr(run, field) != getattr(command, field) for field in fields):
            raise BackupStateError("backup_outcome_conflict")
        return run
    if (
        run.started_at is None
        or command.finished_at < run.started_at
        or (command.verified_at is not None and command.verified_at < run.started_at)
    ):
        raise BackupStateError("backup_outcome_conflict")
    if run.verified_at is not None and any(
        getattr(run, field) != getattr(command, field)
        for field in ("snapshot_id", "manifest_sha256", "verified_at")
    ):
        raise BackupStateError("backup_outcome_conflict")
    for field in fields:
        setattr(run, field, getattr(command, field))
    db.flush()
    return run


def retention_candidates(db: Session, instance: str) -> list[BackupRun]:
    return list(
        db.scalars(
            select(BackupRun)
            .where(
                BackupRun.installation_id == instance,
                BackupRun.verified_at.is_not(None),
                BackupRun.reconciled_at.is_not(None),
                BackupRun.expired_at.is_(None),
            )
            .order_by(BackupRun.verified_at.desc(), BackupRun.id.desc())
            .limit(100)
        ).all()
    )


def heartbeat(db: Session, instance: str, claim_id: UUID) -> None:
    """Refresh runner_last_seen_at while the runner still owns an unreconciled claim."""
    run = exact_claim(db, instance, claim_id)
    if run is None or run.state != "running" or run.reconciled_at is not None:
        raise BackupStateError("backup_identity_conflict")
    policy = db.scalar(select(BackupPolicy).with_for_update())
    if policy is None:
        raise BackupStateError("backup_identity_conflict")
    policy.runner_last_seen_at = utc_now()
    db.flush()


def record_expiry(db: Session, instance: str, command: ExpireCommand) -> BackupRun:
    run = exact_claim(db, instance, command.claim_id, command.run_id, lock=True)
    if (
        run is None
        or run.snapshot_id != command.snapshot_id
        or run.verified_at is None
        or run.reconciled_at is None
    ):
        raise BackupStateError("backup_identity_conflict")
    if run.expired_at is not None:
        if run.expired_at != command.expired_at:
            raise BackupStateError("backup_outcome_conflict")
        return run
    newer = db.scalar(
        select(BackupRun.id)
        .where(
            BackupRun.installation_id == instance,
            BackupRun.verified_at > run.verified_at,
            BackupRun.reconciled_at.is_not(None),
            BackupRun.expired_at.is_(None),
        )
        .limit(1)
    )
    if newer is None:
        raise BackupStateError("backup_latest_protected")
    if command.expired_at < run.verified_at:
        raise BackupStateError("backup_outcome_conflict")
    run.expired_at = command.expired_at
    db.flush()
    return run


def record_release(db: Session, command: ReleaseCommand) -> None:
    workspace(db, lock=True)
    observed = db.scalar(
        select(UpdateStatus).with_for_update().execution_options(populate_existing=True)
    )
    if observed is None:
        observed = UpdateStatus()
        db.add(observed)
    if observed.checked_at is not None and observed.checked_at > command.checked_at:
        raise BackupStateError("release_observation_conflict")
    observed.checked_at, observed.failure_code = command.checked_at, command.failure_code
    if command.failure_code is None:
        observed.latest_version, observed.release_url = command.version, command.release_url
        observed.observed_at = command.checked_at
    db.flush()


def version_status(db: Session, running: str, *, now: datetime | None = None) -> VersionResponse:
    row = db.scalar(select(UpdateStatus))
    result = VersionResponse(
        current_version=running,
        status="unknown",
        latest_version=None,
        observed_at=None,
        checked_at=None,
        failure_code=None,
        release_url=None,
    )
    if row is None:
        return result
    for field in ("latest_version", "observed_at", "checked_at", "failure_code", "release_url"):
        setattr(result, field, getattr(row, field))
    if row.failure_code is not None:
        result.status = "unavailable"
    elif row.observed_at is None:
        result.status = "unknown"
    elif (now or utc_now()) - row.observed_at > timedelta(hours=24):
        result.status = "stale"
    elif row.latest_version is None or not VERSION_PATTERN.fullmatch(running):
        result.status = "unknown"
    else:
        latest = tuple(int(part) for part in row.latest_version.split("."))
        current = tuple(int(part) for part in running.split("."))
        result.status = "available" if latest > current else "current"
    return result


def adopt_policy(
    db: Session, instance: str, project: str, marker: dict[str, Any], *, now: datetime | None = None
) -> BackupPolicy:
    policy = lock_policy(db, instance)
    if (
        marker.get("format_version") != 3
        or marker.get("source_installation_id") != policy.installation_id
        or marker.get("target_instance_id") != instance
        or marker.get("target_project") != project
        or marker.get("application_sessions_invalidated") is not True
        or not re.fullmatch(r"[0-9a-f]{64}", str(marker.get("snapshot_id", "")))
        or not re.fullmatch(r"[0-9a-f]{12,64}", str(marker.get("target_db_container_id", "")))
    ):
        raise BackupStateError("restore_marker_invalid")
    try:
        completed = datetime.fromisoformat(str(marker["completed_at"]))
        if completed.tzinfo is None:
            raise ValueError
    except (KeyError, ValueError):
        raise BackupStateError("restore_marker_invalid") from None
    if policy.installation_id == instance:
        return policy
    if unresolved_run(db, instance) is not None:
        raise BackupStateError("backup_recovery_required")
    policy.installation_id, policy.timezone = instance, workspace(db).timezone
    policy.next_due_at = future_due(policy.schedule, policy.timezone, now or utc_now())
    policy.runner_last_seen_at = None
    policy.revision += 1
    db.flush()
    return policy
