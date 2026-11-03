"""S3: the admin-only organization part of the system status: backup freshness against the
schedule, failed jobs and sign-in activity of the last 7 days (PostgreSQL)."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database.organization_scope import scope_session
from app.core.database.session import get_db
from app.main import create_app
from app.systems.access.users.models import User
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.backups.models import BackupPolicy, BackupRun
from app.systems.manage.backups.service import BackupStateError
from app.systems.manage.health import organization as organization_part
from app.systems.manage.health import service
from app.systems.platform.scheduling.models import ScheduledWork
from tests.conftest import make_operator
from tests.organization_scope_support import scoped_override
from tests.platform_scheduling.support import report_work_subject
from tests.rbac.support import add_user, organization

pytestmark = pytest.mark.integration

NOW = datetime(2027, 3, 8, 12, tzinfo=UTC)
DUE = datetime(2027, 3, 8, 2, tzinfo=UTC)
INSTANCE = "s3-health-instance"
OTHER = "s3-other-instance"


def _policy(db: Session, *, schedule: str | None, installation: str = INSTANCE,
            next_due_at: datetime | None = None) -> None:
    """Set the installation's single backup policy; ``schedule=None`` removes it."""

    policy = db.scalar(select(BackupPolicy))
    if schedule is None:
        if policy is not None:
            db.delete(policy)
            db.flush()
        return
    if policy is None:
        policy = BackupPolicy(installation_id=installation, timezone="UTC")
        db.add(policy)
    policy.installation_id = installation
    policy.schedule = schedule
    policy.next_due_at = next_due_at if schedule != "disabled" else None
    db.flush()


def _run(db: Session, state: str, finished_at: datetime, *, installation: str = INSTANCE,
         scheduled_for: datetime | None = None) -> BackupRun:
    started = finished_at - timedelta(minutes=5)
    succeeded = state == "succeeded"
    run = BackupRun(
        installation_id=installation,
        name="Nightly secret-name",
        provenance="scheduled" if scheduled_for is not None else "manual",
        idempotency_hash=None if scheduled_for is not None else uuid7().hex + uuid7().hex,
        schedule="daily",
        retention_days=30,
        requested_at=started - timedelta(minutes=1),
        scheduled_for=scheduled_for,
        state=state,
        claim_id=uuid7(),
        claimed_schedule="daily",
        claimed_retention_days=30,
        started_at=started,
        finished_at=finished_at,
        reconciled_at=finished_at,
        snapshot_id="a" * 64 if succeeded else None,
        manifest_sha256="b" * 64 if succeeded else None,
        verified_at=finished_at if succeeded else None,
        failure_code=None if succeeded else "backup_failed",
    )
    db.add(run)
    db.flush()
    return run


def _freshness(db: Session) -> dict[str, object]:
    return organization_part.backup_freshness(db, INSTANCE, NOW).model_dump()


@pytest.mark.parametrize(
    ("case", "expected"),
    [
        ("no_policy", ("no_schedule", None, None)),
        ("disabled", ("no_schedule", None, None)),
        ("other_installation_policy", ("no_schedule", None, None)),
        ("never", ("never_backed_up", None, "failed")),
        ("due_within_the_hour", ("on_time", DUE - timedelta(days=1), "verified")),
        ("over_an_hour_late", ("late", DUE - timedelta(days=1), "verified")),
        ("manual_success_after_due", ("on_time", DUE + timedelta(hours=2), "verified")),
        ("last_failed_after_success", ("late", DUE - timedelta(days=1), "failed")),
        ("dead_runner_past_due", ("late", DUE - timedelta(days=1), "verified")),
        ("other_installation_runs", ("never_backed_up", None, None)),
    ],
)
def test_s3_c2_backup_state_against_the_schedule(integration_owner_db: Session, case, expected):
    db = integration_owner_db
    yesterday = DUE - timedelta(days=1)
    if case in {"no_policy", "disabled", "other_installation_policy"}:
        _policy(db, schedule={"no_policy": None, "disabled": "disabled"}.get(case, "daily"),
                installation=OTHER if case == "other_installation_policy" else INSTANCE,
                next_due_at=DUE + timedelta(days=1))
    elif case == "dead_runner_past_due":
        # The stored due time only advances when the runner claims a run.
        _policy(db, schedule="daily", next_due_at=DUE)
        _run(db, "succeeded", yesterday, scheduled_for=yesterday - timedelta(minutes=10))
    else:
        _policy(db, schedule="daily", next_due_at=DUE + timedelta(days=1))
        if case == "never":
            _run(db, "failed", yesterday, scheduled_for=yesterday - timedelta(minutes=10))
        elif case == "other_installation_runs":
            _run(db, "succeeded", NOW - timedelta(hours=1), installation=OTHER)
        else:
            _run(db, "succeeded", yesterday, scheduled_for=yesterday - timedelta(minutes=10))
            # Last due time = the latest scheduled occurrence at or before now.
            occurrence = DUE if case != "due_within_the_hour" else NOW - timedelta(minutes=30)
            if case == "manual_success_after_due":
                _run(db, "succeeded", DUE + timedelta(hours=2))
            if case == "last_failed_after_success":
                _run(db, "failed", DUE + timedelta(minutes=20), scheduled_for=occurrence)
            else:
                # A queued occurrence that has not finished still sets the due time.
                db.add(BackupRun(
                    installation_id=INSTANCE, name="Queued", provenance="scheduled",
                    schedule="daily", retention_days=30, requested_at=occurrence,
                    scheduled_for=occurrence, state="queued",
                ))
                db.flush()

    state, last_success_at, last_result = expected
    assert _freshness(db) == {
        "state": state, "last_success_at": last_success_at, "last_result": last_result,
    }


def _admin_client(db: Session, admin: User) -> TestClient:
    application = create_app()
    application.dependency_overrides[get_db] = lambda: db
    application.dependency_overrides[get_current_user] = scoped_override(lambda: admin)
    return TestClient(application)


def test_s3_c2_t3_an_admin_gets_freshness_words_only_and_an_unknown_identity_hides_jobs(
    integration_owner_db: Session, monkeypatch,
):
    db = integration_owner_db
    monkeypatch.setattr(service, "_cached", None)
    monkeypatch.setattr(service, "get_readiness_snapshot", lambda: {
        "status": "ready",
        "components": {name: {"status": "ready", "required": True}
                       for name in ("database", "auth", "storage", "smtp")},
    })
    monkeypatch.setattr(organization_part, "installation_id", lambda _db: INSTANCE)
    admin = add_user(db, role="admin")
    _policy(db, schedule="daily", next_due_at=DUE + timedelta(days=1))
    finished = datetime.now(UTC) - timedelta(hours=3)
    _run(db, "succeeded", finished - timedelta(hours=1))
    _run(db, "failed", finished)
    db.commit()

    body = _admin_client(db, admin).get("/api/system/status").json()

    assert body["organization"]["backups"] == {
        "state": "on_time",
        "last_success_at": (finished - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        "last_result": "failed",
    }
    assert body["organization"]["failed_jobs"] == 0
    for private in ("secret-name", "backup_failed", "aaaa", "bbbb", "snapshot", "size", "path"):
        assert private not in str(body)

    def unknown(_db):
        raise BackupStateError("backup_identity_conflict")

    monkeypatch.setattr(organization_part, "installation_id", unknown)
    hidden = _admin_client(db, admin).get("/api/system/status").json()["organization"]
    assert hidden["backups"] == {"state": "unknown", "last_success_at": None, "last_result": None}
    assert hidden["failed_jobs"] is None


def _failed_report_work(db: Session, org_id: UUID, report_id: UUID,
                        scheduled_for: datetime, *, state: str = "failed") -> None:
    work = ScheduledWork(org_id=org_id, kind="report-run", report_id=report_id,
                         scheduled_for=scheduled_for, next_attempt_at=scheduled_for)
    db.add(work)
    db.flush()
    if state == "failed":
        work.state = "failed"
        work.attempt_count = 5
        work.failure_code = "attempts_exhausted"
        work.last_attempt_started_at = scheduled_for
        work.finished_at = scheduled_for + timedelta(seconds=1)
        db.flush()


def test_s3_c3_failed_jobs_of_seven_days_in_the_bound_organization_only(
    integration_owner_db: Session, monkeypatch,
):
    db = integration_owner_db
    monkeypatch.setattr(organization_part, "installation_id", lambda _db: INSTANCE)
    org_a = organization(db)
    _owner, report, *_ = report_work_subject(db)
    _failed_report_work(db, org_a.id, report.id, NOW - timedelta(days=1))
    _failed_report_work(db, org_a.id, report.id, NOW - timedelta(days=8))
    _failed_report_work(db, org_a.id, report.id, NOW - timedelta(hours=1), state="pending")
    _run(db, "failed", NOW - timedelta(days=2))
    admin = add_user(db, role="admin")
    operator = make_operator(db, add_user(db, role="admin"))
    # Organization B, with its own failed job inside the window.
    db.info.pop("rbac_organization")
    _other_owner, other_report, *_ = report_work_subject(db)
    _failed_report_work(db, organization(db).id, other_report.id, NOW - timedelta(days=1))
    db.info["rbac_organization"] = org_a
    scope_session(db, org_a.id)

    counted = {
        "admin": organization_part.organization_status(db, admin, now=NOW),
        "operator": organization_part.organization_status(db, operator, now=NOW),
    }

    assert counted["admin"] is not None and counted["operator"] is not None
    assert counted["admin"].failed_jobs == 1
    assert counted["operator"].failed_jobs == 2
    assert counted["admin"].since == NOW - timedelta(days=7)


def _event(db: Session, event_type: str, subject: UUID | None, occurred_at: datetime) -> None:
    append_security_event(db, SecurityEventIngestRequest(
        event_type=event_type,
        outcome="failure" if event_type == "identity.sign_in_failure" else "denied",
        source="identity.login",
        operation_id=uuid7(),
        occurred_at=occurred_at,
        subject_id=subject,
        metadata={"ip_address": "192.0.2.10"},
    ))


def test_s3_c4_sign_in_failures_and_lockouts_of_members_in_seven_days(
    integration_owner_db: Session, monkeypatch,
):
    db = integration_owner_db
    monkeypatch.setattr(organization_part, "installation_id", lambda _db: INSTANCE)
    org_a = organization(db)
    admin = add_user(db, role="admin")
    member = add_user(db)
    _event(db, "identity.sign_in_failure", member.id, NOW - timedelta(days=1))
    _event(db, "identity.sign_in_failure", member.id, NOW - timedelta(days=2))
    _event(db, "identity.lockout", member.id, NOW - timedelta(hours=2))
    _event(db, "identity.sign_in_failure", member.id, NOW - timedelta(days=8))
    _event(db, "identity.lockout", None, NOW - timedelta(hours=1))
    db.info.pop("rbac_organization")
    outsider = add_user(db)
    _event(db, "identity.sign_in_failure", outsider.id, NOW - timedelta(days=1))
    _event(db, "identity.lockout", outsider.id, NOW - timedelta(days=1))
    db.info["rbac_organization"] = org_a
    scope_session(db, org_a.id)

    status = organization_part.organization_status(db, admin, now=NOW)

    assert status is not None
    assert (status.failed_sign_ins, status.lockouts) == (2, 1)
