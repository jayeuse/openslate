"""Private claim/outcome boundaries need real PostgreSQL, not browser outage actions."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError, ProgrammingError
from sqlalchemy.orm import Session

from app.main import create_app
from app.systems.access.users.models import UserRole
from tests.rbac.support import _client, add_user

pytestmark = pytest.mark.integration
NOW = datetime(2026, 10, 5, 12, tzinfo=UTC)


def _queue(db: Session, name: str = "Boundary backup"):
    actor = add_user(db, role=UserRole.ADMIN)
    response = _client(create_app(), actor, db).post(
        "/api/backups", json={"name": name}, headers={"Idempotency-Key": uuid4().hex}
    )
    assert response.status_code == 201
    from app.systems.manage.backups.models import BackupRun

    return db.get(BackupRun, UUID(response.json()["id"]))


def _after_database_now(db: Session) -> datetime:
    """One second after the database clock; Docker's VM clock can run ahead of the host."""
    return db.connection().scalar(text("SELECT clock_timestamp()")) + timedelta(seconds=1)


def _identity(db: Session) -> str:
    return db.connection().scalar(text("SELECT current_setting('cluster_name')"))


def test_claim_replay_outcome_cas_and_failed_claim_remains_unresolved(
    integration_db: Session,
) -> None:
    from app.systems.manage.backups import service
    from app.systems.manage.backups.schemas import OutcomeCommand

    run = _queue(integration_db)
    second = _queue(integration_db, "Waiting")
    instance, claim_id = _identity(integration_db), uuid4()
    current = _after_database_now(integration_db)
    claimed = service.claim_run(integration_db, instance, claim_id, now=current)
    assert claimed.id == run.id and claimed.state == "running"
    assert service.claim_run(integration_db, instance, claim_id, now=current).id == run.id
    assert service.unresolved_run(integration_db, instance).id == run.id
    with pytest.raises(service.BackupStateError, match="backup_recovery_required"):
        service.claim_run(integration_db, instance, uuid4(), now=current)
    assert second.state == "queued"
    payload = OutcomeCommand(
        op="outcome",
        installation_id=instance,
        project="owned-project",
        run_id=run.id,
        claim_id=claim_id,
        state="failed",
        finished_at=current + timedelta(seconds=2),
        reconciled_at=None,
        snapshot_id=None,
        manifest_sha256=None,
        verified_at=None,
        failure_code="restart_failed",
    )
    service.record_outcome(integration_db, instance, payload)
    assert run.state == "failed" and service.unresolved_run(integration_db, instance).id == run.id
    with pytest.raises(service.BackupStateError, match="backup_identity_conflict"):
        service.record_outcome(integration_db, "foreign-source", payload)
    with pytest.raises(service.BackupStateError, match="backup_identity_conflict"):
        service.record_outcome(
            integration_db, instance, payload.model_copy(update={"claim_id": uuid4()})
        )
    complete = payload.model_copy(
        update={
            "state": "succeeded",
            "snapshot_id": "a" * 64,
            "manifest_sha256": "b" * 64,
            "verified_at": current + timedelta(seconds=1),
            "reconciled_at": current + timedelta(seconds=3),
            "failure_code": None,
        }
    )
    service.record_outcome(integration_db, instance, complete)
    assert service.unresolved_run(integration_db, instance) is None
    service.record_outcome(integration_db, instance, complete)
    with pytest.raises(service.BackupStateError, match="backup_outcome_conflict"):
        service.record_outcome(integration_db, instance, payload)


def test_foreign_history_is_not_claimed_and_inherited_policy_requires_adoption(
    integration_db: Session,
) -> None:
    from app.systems.manage.backups import service
    from app.systems.manage.backups.models import BackupPolicy

    foreign = _queue(integration_db)
    foreign.installation_id = "old-installation"
    foreign.claim_id, foreign.started_at, foreign.state = uuid4(), datetime.now(UTC), "running"
    foreign.claimed_schedule, foreign.claimed_retention_days = "disabled", 30
    integration_db.flush()
    instance = _identity(integration_db)
    assert service.unresolved_run(integration_db, instance) is None
    assert service.claim_run(integration_db, instance, uuid4()) is None
    policy = integration_db.scalar(select(BackupPolicy))
    policy.installation_id, policy.schedule, policy.retention_days = (
        "old-installation",
        "weekly",
        90,
    )
    integration_db.flush()
    with pytest.raises(service.BackupStateError, match="backup_adoption_required"):
        service.claim_run(integration_db, instance, uuid4())
    bad = {
        "format_version": 3,
        "source_installation_id": "wrong-source",
        "target_instance_id": instance,
        "target_project": instance,
        "application_sessions_invalidated": True,
        "snapshot_id": "a" * 64,
        "completed_at": NOW.isoformat(),
        "target_db_container_id": "b" * 64,
    }
    with pytest.raises(service.BackupStateError, match="restore_marker_invalid"):
        service.adopt_policy(integration_db, instance, instance, bad, now=NOW)
    marker = {**bad, "source_installation_id": "old-installation"}
    from app.systems.manage.backups.schemas import AdoptCommand
    from operations import backup_state

    result = backup_state.execute(
        integration_db,
        AdoptCommand(
            op="adopt",
            installation_id=instance,
            project=instance,
            restore_marker=marker,
        ),
    )
    assert result["policy"]["adopted"] is True
    assert policy.installation_id == instance and policy.schedule == "weekly"
    assert policy.retention_days == 90 and policy.next_due_at > datetime.now(UTC)
    assert foreign.state == "running" and foreign.installation_id == "old-installation"


def test_due_schedule_catches_up_once_and_timezone_rebases_cursor(integration_db: Session) -> None:
    from app.systems.manage.backups import service
    from app.systems.manage.backups.models import BackupPolicy, BackupRun
    from app.systems.manage.workspace.models import WorkspaceProfile

    instance = _identity(integration_db)
    policy = BackupPolicy(
        installation_id=instance,
        timezone="UTC",
        schedule="daily",
        next_due_at=NOW - timedelta(days=10),
        retention_days=7,
    )
    integration_db.add(policy)
    integration_db.flush()
    claimed = service.claim_run(integration_db, instance, uuid4(), now=NOW)
    assert claimed.provenance == "scheduled" and claimed.scheduled_for == NOW - timedelta(days=10)
    assert policy.next_due_at > NOW
    assert len(integration_db.scalars(select(BackupRun)).all()) == 1
    policy.timezone, policy.next_due_at = "Asia/Manila", NOW - timedelta(days=1)
    profile = integration_db.scalar(select(WorkspaceProfile))
    profile.timezone = "UTC"
    pending = service.policy_response(integration_db, instance, now=NOW)
    assert pending.timezone == "UTC" and pending.next_due_at > NOW
    assert policy.timezone == "Asia/Manila" and policy.next_due_at < NOW
    claimed.finished_at, claimed.reconciled_at, claimed.state = NOW, NOW, "failed"
    claimed.failure_code = "backup_failed"
    integration_db.flush()
    assert service.claim_run(integration_db, instance, uuid4(), now=NOW) is None
    assert policy.timezone == "UTC" and policy.next_due_at > NOW
    assert len(integration_db.scalars(select(BackupRun)).all()) == 1


def test_database_excludes_second_unresolved_claim_independently_of_service(
    integration_db: Session,
) -> None:
    from app.systems.manage.backups import service

    first, second = _queue(integration_db), _queue(integration_db, "Second claim")
    started = _after_database_now(integration_db)
    service.claim_run(integration_db, _identity(integration_db), uuid4(), now=started)
    assert first.started_at is not None
    second.started_at, second.claim_id, second.state = started, uuid4(), "running"
    second.claimed_schedule, second.claimed_retention_days = "disabled", 30
    with pytest.raises(IntegrityError) as error:
        integration_db.flush()
    assert error.value.orig.diag.constraint_name == "uq_backup_runs_unresolved"


def test_runtime_grants_allow_metadata_and_deny_schema_creation(integration_db: Session) -> None:
    connection = integration_db.connection()
    assert connection.scalar(text("SELECT current_user")) == "openslate_runtime"
    for table in ("backup_policies", "backup_runs", "update_statuses"):
        assert (
            connection.scalar(
                text(
                    "SELECT has_table_privilege(current_user, :table, "
                    "'SELECT,INSERT,UPDATE,DELETE')"
                ),
                {"table": "public." + table},
            )
            is True
        )
    with integration_db.begin_nested():
        with pytest.raises(ProgrammingError) as error:
            connection.execute(text("CREATE TABLE public.backup_permission_probe (id integer)"))
        assert error.value.orig.sqlstate == "42501"


@pytest.mark.parametrize(
    "changed",
    (
        {"retention_days": 14},
        {"state": "invented"},
        {"installation_id": ""},
        {"snapshot_id": "a" * 64},
        {"is_deleted": True},
        {"started_at": NOW, "claim_id": uuid4(), "state": "running"},
    ),
)
def test_runtime_database_rejects_invalid_history(integration_db: Session, changed: dict) -> None:
    run = _queue(integration_db)
    for field, value in changed.items():
        setattr(run, field, value)
    with pytest.raises(IntegrityError):
        integration_db.flush()


def test_version_failure_preserves_success_and_retention_protects_latest(
    integration_db: Session,
) -> None:
    from app.systems.manage.backups import service
    from app.systems.manage.backups.schemas import ExpireCommand, OutcomeCommand, ReleaseCommand

    instance = _identity(integration_db)
    service.record_release(
        integration_db,
        ReleaseCommand(
            op="release",
            installation_id=instance,
            project="owned-project",
            checked_at=NOW,
            version="9.0.0",
            release_url="https://github.com/jayeuse/openslate/releases/tag/v9.0.0",
            failure_code=None,
        ),
    )
    assert service.version_status(integration_db, "0.1.0", now=NOW).status == "available"
    service.record_release(
        integration_db,
        ReleaseCommand(
            op="release",
            installation_id=instance,
            project="owned-project",
            checked_at=NOW + timedelta(hours=1),
            version=None,
            release_url=None,
            failure_code="release_unavailable",
        ),
    )
    observed = service.version_status(integration_db, "0.1.0", now=NOW + timedelta(hours=1))
    assert observed.status == "unavailable" and observed.latest_version == "9.0.0"
    assert observed.observed_at == NOW
    rows = []
    previous = None
    for index in range(2):
        run = _queue(integration_db, f"Completed {index}")
        # After the queue request: its requested_at comes from the database clock.
        at = _after_database_now(integration_db)
        if previous is not None:
            at = max(at, previous + timedelta(seconds=10))
        previous = at
        claim = uuid4()
        service.claim_run(
            integration_db, instance, claim, now=at
        )
        service.record_outcome(
            integration_db,
            instance,
            OutcomeCommand(
                op="outcome",
                installation_id=instance,
                project="owned-project",
                run_id=run.id,
                claim_id=claim,
                state="succeeded",
                finished_at=at + timedelta(seconds=3),
                reconciled_at=at + timedelta(seconds=4),
                snapshot_id=str(index) * 64,
                manifest_sha256="a" * 64,
                verified_at=at + timedelta(seconds=2),
                failure_code=None,
            ),
        )
        rows.append(run)
    latest = rows[-1]
    expiry = ExpireCommand(
        op="expire",
        installation_id=instance,
        project="owned-project",
        run_id=latest.id,
        claim_id=latest.claim_id,
        snapshot_id=latest.snapshot_id,
        expired_at=at + timedelta(days=90),
    )
    with pytest.raises(service.BackupStateError, match="backup_latest_protected"):
        service.record_expiry(integration_db, instance, expiry)
    older = expiry.model_copy(
        update={
            "run_id": rows[0].id,
            "claim_id": rows[0].claim_id,
            "snapshot_id": rows[0].snapshot_id,
        }
    )
    service.record_expiry(integration_db, instance, older)
    service.record_expiry(integration_db, instance, older)
    assert rows[0].expired_at is not None and latest.expired_at is None


def test_heartbeat_refreshes_last_seen_only_for_the_running_claim(
    integration_db: Session,
) -> None:
    # A long run used to show "recovery required" after five minutes because
    # runner_last_seen_at was written only at claim time.
    from app.systems.manage.backups import service
    from app.systems.manage.backups.models import BackupPolicy

    _queue(integration_db)
    instance, claim_id = _identity(integration_db), uuid4()
    service.claim_run(
        integration_db, instance, claim_id, now=_after_database_now(integration_db)
    )
    policy = integration_db.scalar(select(BackupPolicy))
    assert policy is not None
    claimed_at = datetime.now(UTC) - timedelta(minutes=30)
    policy.runner_last_seen_at = claimed_at  # a run that has been working for 30 minutes
    integration_db.flush()
    assert service.status_response(integration_db, instance).runner.state == "recovery_required"

    service.heartbeat(integration_db, instance, claim_id)
    integration_db.refresh(policy)
    assert policy.runner_last_seen_at is not None
    assert policy.runner_last_seen_at > claimed_at + timedelta(minutes=29)
    assert service.status_response(integration_db, instance).runner.state == "available"

    with pytest.raises(service.BackupStateError, match="backup_identity_conflict"):
        service.heartbeat(integration_db, instance, uuid4())
