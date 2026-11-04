"""S5: the minute sampler, the shared 30-day periods and the owner and admin parts
of the system status (PostgreSQL)."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, func, select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_current_user
from app.core.database.organization_scope import scope_session
from app.core.database.session import get_db
from app.main import create_app
from app.systems.manage.audit.models import AuditLog, SecurityEvent
from app.systems.manage.backups.models import BackupPolicy
from app.systems.manage.health import errors, history, service, signals
from app.systems.manage.health.models import SystemHealthSample, SystemHealthSignal
from app.systems.manage.health.worker import SystemHealthWorker
from app.systems.platform.files.models import File
from tests.conftest import create_member, create_organization, make_operator
from tests.organization_scope_support import scoped_override
from tests.runtime.health_support import (
    add_sample,
    clear_samples,
    kept_signals,
    runtime_engine,
    sample_rows,
    set_signals,
    written_counts,
)

pytestmark = pytest.mark.integration

MINUTE = datetime(2026, 11, 5, 10, 0, tzinfo=UTC)
READY = {
    "status": "ready",
    "components": {
        name: {"status": "ready", "required": True}
        for name in ("database", "auth", "storage", "smtp")
    },
}


def _probe(**times: int):
    return lambda: (READY, {"database": 20, "auth": 30, "storage": 40, **times})


def _worker() -> SystemHealthWorker:
    from app.core.config import Settings
    from tests.config_support import settings_values

    return SystemHealthWorker(Settings(**settings_values(), _env_file=None), probe=_probe())


@pytest.fixture
def no_samples():
    clear_samples()
    try:
        yield
    finally:
        clear_samples()


def test_s5_c1_i1_two_processes_store_one_sample_a_minute_and_a_held_lock_skips(
    no_samples, quiet_email
):
    first, second = _worker(), _worker()

    assert first.sample_once(now=MINUTE + timedelta(seconds=3)) is True
    assert second.sample_once(now=MINUTE + timedelta(seconds=9)) is False
    later = MINUTE + timedelta(minutes=1)
    with runtime_engine().connect() as holder:
        holder.execute(text(
            "SELECT pg_advisory_xact_lock(hashtextextended('slateops:system-health-sampler', 0))"
        ))
        assert second.sample_once(now=later) is False
        holder.rollback()
    assert second.sample_once(now=later) is True

    rows = sample_rows()
    assert [row[:8] for row in rows] == [
        (MINUTE, "working", 20, "working", 30, "working", 40, "set_up"),
        (later, "working", 20, "working", 30, "working", 40, "set_up"),
    ]
    # The writer measures the database it writes to.
    assert all(row[8] is not None and row[8] > 0 for row in rows)


def test_s5_c1_i1_a_sampler_that_finds_its_minute_stored_under_the_lock_writes_nothing(
    no_samples, quiet_email
):
    first, second = _worker(), _worker()
    second_wrote: list[bool] = []

    def probe_while_the_second_writes():
        # Both samplers passed the lock-free check; the second stores the minute first.
        second_wrote.append(second.sample_once(now=MINUTE + timedelta(seconds=5)))
        return READY, {"database": 99, "auth": 98, "storage": 97}

    assert first.sample_once(now=MINUTE + timedelta(seconds=3),
                             probe=probe_while_the_second_writes) is False

    assert second_wrote == [True]
    # The first found the minute under the lock: no failed insert, nothing kept to retry.
    assert first.buffered == 0
    assert [row[:8] for row in sample_rows()] == [
        (MINUTE, "working", 20, "working", 30, "working", 40, "set_up"),
    ]


def test_s5_c1_i2_minutes_kept_while_the_database_is_down_are_written_once(
    no_samples, quiet_email, monkeypatch
):
    worker = _worker()

    def refused(pending):
        raise OperationalError("INSERT", {}, ConnectionRefusedError())

    with monkeypatch.context() as down:
        down.setattr(worker, "_write", refused)
        for minute in range(3):
            assert worker.sample_once(now=MINUTE + timedelta(minutes=minute)) is False
    # Another process stored the first of those minutes before this one recovered.
    add_sample(MINUTE, database_bytes=7)

    assert worker.buffered == 3
    assert worker.sample_once(now=MINUTE + timedelta(minutes=3)) is True
    assert worker.buffered == 0
    rows = sample_rows()
    assert [(row[0], row[1], row[7], row[8] is None) for row in rows] == [
        (MINUTE, "working", "set_up", False),
        (MINUTE + timedelta(minutes=1), "not_working", "set_up", True),
        (MINUTE + timedelta(minutes=2), "not_working", "set_up", True),
        (MINUTE + timedelta(minutes=3), "working", "set_up", False),
    ]


@pytest.fixture
def quiet_email():
    """No recent email outcome: other tests' invitations commit real ones.

    Requested before ``integration_db`` so the restore runs after the test transaction,
    which may hold row locks on the signals, has ended.
    """

    with kept_signals():
        set_signals(email_accepted=None, email_failed=None)
        yield


@pytest.fixture
def people(quiet_email, integration_db: Session, monkeypatch):
    monkeypatch.setattr(service, "_cached", None)
    monkeypatch.setattr(service, "get_readiness_snapshot", lambda: READY)
    monkeypatch.setattr(history, "_cached", None)
    db = integration_db
    organization = create_organization(db)
    admin, _ = create_member(db, organization, "admin")
    member, _ = create_member(db, organization, "member")
    guest, _ = create_member(
        db, organization, "guest", sponsor_user_id=admin.id,
        expires_at=datetime.now(UTC) + timedelta(days=7),
    )
    owner, _ = create_member(db, organization, "admin")
    make_operator(db, owner)
    db.commit()
    return db, organization, {"admin": admin, "member": member, "guest": guest, "owner": owner}


def _client(db: Session, actor) -> TestClient:
    application = create_app()
    application.dependency_overrides[get_db] = lambda: db
    application.dependency_overrides[get_current_user] = scoped_override(lambda: actor)
    return TestClient(application)


def _add(db: Session, at: datetime, **values) -> None:
    row = {"data_status": "working", "data_ms": 20, "signing_in_status": "working",
           "signing_in_ms": 30, "files_status": "working", "files_ms": 40,
           "email_status": "set_up", **values}
    db.add(SystemHealthSample(sampled_at=at, **row))


def _z(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


def test_s5_c3_i6_every_person_reads_the_same_periods_and_a_signed_out_one_none(people, no_samples):
    db, _organization, actors = people
    now = datetime.now(UTC).replace(second=0, microsecond=0)
    # The newest sample is this minute, so the run stays going with minutes of slack.
    email_from, slow_from = now - timedelta(hours=2), now - timedelta(minutes=2)
    for minute in range(12):
        _add(db, email_from + timedelta(minutes=minute), email_status="not_working")
    for minute in range(12, 30):
        _add(db, email_from + timedelta(minutes=minute))
    for minute in range(3):
        _add(db, slow_from + timedelta(minutes=minute), files_ms=1500)
    db.commit()

    answers = {
        role: _client(db, actor).get("/api/system/health-periods").json()
        for role, actor in actors.items()
    }
    second_page = _client(db, actors["member"]).get(
        "/api/system/health-periods", params={"limit": 1, "offset": 1}
    ).json()
    signed_out = TestClient(create_app()).get("/api/system/health-periods")

    expected = [
        {"part": "files", "kind": "slow", "started_at": _z(slow_from), "ended_at": None},
        {"part": "email", "kind": "not_working", "started_at": _z(email_from),
         "ended_at": _z(email_from + timedelta(minutes=12))},
    ]
    assert answers["member"] == {
        "items": expected,
        "pagination": {"limit": 5, "offset": 0, "count": 2, "total": 2, "has_more": False},
        "oldest_sample_at": _z(email_from),
    }
    assert all(answer == answers["member"] for answer in answers.values())
    assert second_page["items"] == expected[1:]
    assert second_page["pagination"]["has_more"] is False
    assert signed_out.status_code == 401


def test_s5_c3_the_history_reads_sample_values_without_loading_sample_rows_as_objects(
    no_samples, integration_db: Session
):
    now = datetime.now(UTC).replace(second=0, microsecond=0)
    add_sample(now - timedelta(minutes=2), files_status="not_working", files_ms=2000)
    add_sample(now - timedelta(minutes=1))
    loaded: list[object] = []

    def on_load(_session, item):
        loaded.append(item)

    event.listen(integration_db, "loaded_as_persistent", on_load)
    try:
        current = history.read_history(integration_db, now)
    finally:
        event.remove(integration_db, "loaded_as_persistent", on_load)

    # Up to 43,200 rows a read: values only, no mapped objects in the session.
    assert loaded == []
    assert current.periods == (
        history.Period("files", "not_working", now - timedelta(minutes=2),
                       now - timedelta(minutes=1)),
    )
    assert current.oldest_sample_at == now - timedelta(minutes=2)


def test_s5_c4_i7_the_status_shows_slow_from_the_newest_samples(people, no_samples):
    db, _organization, actors = people
    now = datetime.now(UTC).replace(second=0, microsecond=0)
    # This minute and the two before it: within the last 4 minutes with minutes of slack.
    for minute in (2, 1, 0):
        _add(db, now - timedelta(minutes=minute), signing_in_ms=2400)
    db.commit()

    parts = _client(db, actors["guest"]).get("/api/system/status").json()["parts"]

    assert [(part["key"], part["status"]) for part in parts] == [
        ("data", "working"), ("signing_in", "slow"), ("files", "working"), ("email", "set_up"),
    ]


def test_s5_c6_i10_only_the_installation_owner_reads_workers_and_the_database_size(
    people, no_samples
):
    db, _organization, actors = people
    now = datetime.now(UTC)
    _add(db, now.replace(second=0, microsecond=0) - timedelta(minutes=5), database_bytes=123456)
    seen = {
        "record_triggers": now - timedelta(minutes=1),
        "report_scheduling": now - timedelta(minutes=10),
        "comms_jobs": None,
        "provider_signout": now - timedelta(minutes=2),
    }
    for key, moment in seen.items():
        db.scalar(select(SystemHealthSignal).where(SystemHealthSignal.key == key)).last_seen_at = (
            moment
        )
    policy = db.scalar(select(BackupPolicy))
    if policy is None:
        policy = BackupPolicy(installation_id="i10-health", timezone="UTC")
        db.add(policy)
    policy.runner_last_seen_at = now - timedelta(minutes=4)
    db.commit()

    bodies = {role: _client(db, actor).get("/api/system/status").json()
              for role, actor in actors.items()}

    assert bodies["owner"]["installation"] == {
        "database_bytes": 123456,
        "database_measured_at": _z(now.replace(second=0, microsecond=0) - timedelta(minutes=5)),
        "workers": [
            {"key": "record_triggers", "state": "running",
             "last_seen_at": _z(seen["record_triggers"])},
            {"key": "report_scheduling", "state": "not_seen",
             "last_seen_at": _z(seen["report_scheduling"])},
            {"key": "comms_jobs", "state": "never_seen", "last_seen_at": None},
            {"key": "provider_signout", "state": "running",
             "last_seen_at": _z(seen["provider_signout"])},
            {"key": "backup_runner", "state": "running",
             "last_seen_at": _z(now - timedelta(minutes=4))},
        ],
    }
    for role in ("admin", "member", "guest"):
        assert bodies[role]["installation"] is None
    with runtime_engine().connect() as connection:
        size = connection.scalar(text("SELECT pg_database_size(current_database())"))
        connection.rollback()
    assert size > 0


def _file(db: Session, creator, org_id, size: int, state: str, purpose="workspace_logo"):
    item = File(
        org_id=org_id, purpose=purpose, creator_id=creator.id, filename="logo.png",
        expected_size=size, actual_size=size if state != "awaiting_upload" else None,
        digest="d" * 64 if state == "ready" else None, object_key=uuid4().hex, state=state,
    )
    if state == "deleting":
        item.is_deleted, item.deleted_at = True, datetime.now(UTC)
    db.add(item)


def test_s5_c7_i12_admins_see_their_organization_storage_and_members_do_not(people):
    db, organization, actors = people
    admin = actors["admin"]
    _file(db, admin, organization.id, 100, "ready")
    _file(db, admin, organization.id, 200, "deleting")
    _file(db, admin, organization.id, 300, "awaiting_upload")
    _file(db, admin, organization.id, 400, "rejected")
    _file(db, admin, None, 500, "ready", purpose="user_avatar")
    db.commit()
    other = create_organization(db)
    other_admin, _ = create_member(db, other, "admin")
    _file(db, other_admin, other.id, 600, "ready")
    db.commit()

    storage = {
        role: (_client(db, actors[role]).get("/api/system/status").json()["organization"] or {})
        .get("storage_used_bytes")
        for role in ("admin", "member", "guest")
    }

    # The trash counts until it is purged; unfinished, rejected and avatar files do not.
    assert storage == {"admin": 300, "member": None, "guest": None}


def _in_session(db: Session, org_id) -> tuple[int, int]:
    # Request writes stay in the test transaction; count them under one fixed binding.
    scope_session(db, org_id)
    return (
        db.scalar(select(func.count()).select_from(AuditLog)) or 0,
        db.scalar(select(func.count()).select_from(SecurityEvent)) or 0,
    )


def test_s5_c8_i13_sampling_signals_and_reads_write_no_audit_or_security_row(
    people, no_samples, monkeypatch
):
    db, organization, actors = people
    monkeypatch.setattr(errors, "_log", errors.ServerErrorLog())
    committed, requested = written_counts(), _in_session(db, organization.id)
    with kept_signals():
        _worker().sample_once(now=MINUTE)
        _worker().retain_once()
        signals.record_signal("email_accepted")
        for actor in actors.values():
            assert _client(db, actor).get("/api/system/status").status_code == 200
            assert _client(db, actor).get("/api/system/health-periods").status_code == 200

    assert written_counts() == committed
    assert _in_session(db, organization.id) == requested
