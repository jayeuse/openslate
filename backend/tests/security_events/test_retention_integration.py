"""Real runtime capability: fixed proofs, rollback, cutoff and committed lock races."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from time import monotonic
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database.session import AuditSession, get_engine
from app.systems.access.identity.provider_signout_worker import ProviderSignoutWorker
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.workspace.models import PlatformSettings

pytestmark = pytest.mark.integration
FIELDS = ("session_retention_days", "security_event_retention_days")


@pytest.fixture
def event_retention_world(integration_owner_db):
    owner, runtime = integration_owner_db.get_bind().engine, get_engine()
    ids = []
    with Session(owner) as db:
        before = set(db.scalars(select(SecurityEvent.id)))
        profile = db.scalar(select(PlatformSettings))
        original = {field: getattr(profile, field) for field in FIELDS if hasattr(profile, field)}

    def add(times):
        rows = [
            SecurityEvent(
                id=uuid4(),
                occurred_at=instant,
                event_type="owned.retention",
                outcome="success",
                source="owned.retention",
                operation_id=uuid4(),
                labels={},
                event_metadata={"owned": "private fact must not enter proof"},
            )
            for instant in times
        ]
        created_ids = [row.id for row in rows]
        ids.extend(created_ids)
        with Session(owner) as db:
            db.add_all(rows)
            db.commit()
        return created_ids

    def proofs():
        with Session(owner) as db:
            return list(
                db.scalars(
                    select(SecurityEvent).where(
                        SecurityEvent.source == "security.event_retention",
                        SecurityEvent.id.not_in(before),
                    )
                )
            )

    def remaining():
        with Session(owner) as db:
            return set(db.scalars(select(SecurityEvent.id).where(SecurityEvent.id.in_(ids))))

    def policy(**values):
        with Session(owner) as db:
            profile = db.scalar(select(PlatformSettings))
            for field, value in values.items():
                setattr(profile, field, value)
            db.commit()

    try:
        yield SimpleNamespace(
            owner=owner,
            runtime=runtime,
            add=add,
            proofs=proofs,
            remaining=remaining,
            policy=policy,
            ids=ids,
        )
    finally:
        with Session(owner) as db:
            for row in db.scalars(
                select(SecurityEvent).where(
                    SecurityEvent.id.in_(ids)
                    | (
                        (SecurityEvent.source == "security.event_retention")
                        & SecurityEvent.id.not_in(before)
                    )
                )
            ):
                db.delete(row)
            profile = db.scalar(select(PlatformSettings))
            for field, value in original.items():
                setattr(profile, field, value)
            db.commit()


def _invoke(world, commit=True):
    with AuditSession(world.runtime) as db:
        count = db.scalar(select(func.public.retain_security_events()))
        if commit:
            db.commit()
        else:
            db.rollback()
        return count


def _wait_for_policy_lock(owner, holder_pid):
    deadline = monotonic() + 8
    with owner.connect() as observer:
        while monotonic() < deadline:
            if observer.scalar(
                text(
                    "SELECT count(*) FROM pg_locks WHERE NOT granted "
                    "AND :holder = ANY(pg_blocking_pids(pid))"
                ),
                {"holder": holder_pid},
            ):
                return
    raise AssertionError("Writer/cleanup did not reach the real policy-lock boundary")


def test_existing_worker_cleans_events_with_fixed_atomic_proof(event_retention_world, monkeypatch):
    world = event_retention_world
    old = world.add([datetime.now(UTC) - timedelta(days=400)])
    worker = ProviderSignoutWorker(get_settings())
    monkeypatch.setattr(worker, "run_once", lambda: 0)

    class OnePass:
        stopped = False

        def is_set(self):
            return self.stopped

        def wait(self, _seconds):
            self.stopped = True

    worker._stop = OnePass()
    worker._run()
    assert not world.remaining(), "Existing hourly worker did not perform event retention"
    (proof,) = world.proofs()
    assert proof.id not in old and proof.operation_id != proof.id
    assert proof.event_type == "security.retention" and proof.outcome == "success"
    assert proof.labels == {} and proof.actor_id is None and proof.subject_id is None
    assert proof.request_id is proof.request_method is proof.request_path is None
    assert proof.fingerprint is proof.reason is None
    metadata = proof.event_metadata
    assert set(metadata) == {
        "scope",
        "retention_days",
        "batch_limit",
        "as_of",
        "cutoff",
        "deleted_events",
    }
    assert (
        metadata["scope"],
        metadata["retention_days"],
        metadata["batch_limit"],
        metadata["deleted_events"],
    ) == ("security_events", 365, 1000, 1)
    assert "private fact" not in str(metadata)
    assert datetime.fromisoformat(metadata["as_of"]) == proof.occurred_at
    assert datetime.fromisoformat(metadata["cutoff"]) == proof.occurred_at - timedelta(days=365)


def test_direct_execute_commits_only_bounded_deletion_with_proof(event_retention_world):
    world = event_retention_world
    youngest = datetime.now(UTC) - timedelta(days=400)
    rows = world.add([youngest - timedelta(seconds=i) for i in range(1001)])
    assert _invoke(world) == 1000
    assert world.remaining() == {rows[0]}
    assert len(world.proofs()) == 1
    assert _invoke(world) == 1
    assert _invoke(world) == 0
    assert not world.remaining()
    assert sorted(row.event_metadata["deleted_events"] for row in world.proofs()) == [1, 1000]


def test_exact_future_cutoff_and_independent_configured_period(event_retention_world):
    world = event_retention_world
    world.policy(session_retention_days=1, security_event_retention_days=30)
    with AuditSession(world.runtime) as db:
        as_of = db.scalar(select(func.now())).astimezone(UTC)
        rows = world.add(
            [as_of - timedelta(days=31), as_of - timedelta(days=30), as_of + timedelta(days=1)]
        )
        assert db.scalar(select(func.public.retain_security_events())) == 1
        db.commit()
    assert world.remaining() == set(rows[1:])
    assert world.proofs()[0].event_metadata["retention_days"] == 30


@pytest.mark.parametrize("failure", ["outer_rollback", "proof_insert"])
def test_deletion_and_fixed_proof_roll_back_together(event_retention_world, failure):
    world = event_retention_world
    old = world.add([datetime.now(UTC) - timedelta(days=400)])
    if failure == "outer_rollback":
        assert _invoke(world, commit=False) == 1
    else:
        with world.owner.begin() as connection:
            connection.execute(
                text(
                    "ALTER TABLE public.security_events ADD CONSTRAINT "
                    "owned_retention_proof_failure "
                    "CHECK(source <> 'security.event_retention') NOT VALID"
                )
            )
        try:
            with pytest.raises(DBAPIError):
                _invoke(world)
        finally:
            with world.owner.begin() as connection:
                connection.execute(
                    text(
                        "ALTER TABLE public.security_events DROP CONSTRAINT "
                        "owned_retention_proof_failure"
                    )
                )
    assert world.remaining() == set(old)
    assert world.proofs() == []


def test_advisory_overlap_and_locked_rows_never_create_false_proofs(event_retention_world):
    world = event_retention_world
    with AuditSession(world.runtime) as first:
        assert first.scalar(select(func.public.retain_security_events())) == 0
        ids = world.add([datetime.now(UTC) - timedelta(days=400)])
        assert _invoke(world) == 0
        assert world.remaining() == set(ids) and world.proofs() == []
        first.rollback()
    world.add([datetime.now(UTC) - timedelta(days=400)])
    with Session(world.owner) as held:
        held.scalar(select(SecurityEvent).where(SecurityEvent.id == ids[0]).with_for_update())
        assert _invoke(world) == 1
        assert _invoke(world) == 0
        assert world.remaining() == set(ids)
        assert len(world.proofs()) == 1
        held.rollback()
    assert _invoke(world) == 1


def test_runtime_table_acl_remains_append_only_outside_capability(event_retention_world):
    world = event_retention_world
    with AuditSession(world.runtime) as db:
        event = append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="owned.retention",
                outcome="success",
                source="owned.retention",
                operation_id=uuid4(),
            ),
        )
        world.ids.append(event.id)
        db.commit()
    with world.runtime.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM public.security_events")) >= 1
    for statement in [
        "UPDATE public.security_events SET reason='forbidden' WHERE false",
        "DELETE FROM public.security_events WHERE false",
        "TRUNCATE public.security_events",
    ]:
        with world.runtime.connect() as connection:
            with pytest.raises(DBAPIError) as error:
                connection.execute(text(statement))
            assert error.value.orig.sqlstate == "42501"
            connection.rollback()
    with AuditSession(world.runtime) as db:
        row = db.get(SecurityEvent, world.ids[-1])
        db.delete(row)
        with pytest.raises(RuntimeError):
            db.flush()
        db.rollback()


@pytest.mark.parametrize("first", ["writer", "cleanup"])
def test_policy_and_cleanup_serialize_with_committed_outcomes(event_retention_world, first):
    world = event_retention_world
    old, recent = world.add(
        [datetime.now(UTC) - timedelta(days=400), datetime.now(UTC) - timedelta(days=10)]
    )
    if first == "writer":
        with world.owner.connect() as writer:
            transaction = writer.begin()
            holder_pid = writer.scalar(text("SELECT pg_backend_pid()"))
            writer.execute(
                text("UPDATE public.platform_settings SET security_event_retention_days=1")
            )
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(_invoke, world)
                try:
                    _wait_for_policy_lock(world.owner, holder_pid)
                    transaction.commit()
                    assert pending.result(timeout=8) == 2
                finally:
                    if transaction.is_active:
                        transaction.rollback()
        assert world.remaining() == set()
        assert world.proofs()[0].event_metadata["retention_days"] == 1
    else:
        with AuditSession(world.runtime) as cleanup:
            holder_pid = cleanup.scalar(select(func.pg_backend_pid()))
            assert cleanup.scalar(select(func.public.retain_security_events())) == 1
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(world.policy, security_event_retention_days=1)
                try:
                    _wait_for_policy_lock(world.owner, holder_pid)
                    assert world.remaining() == {old, recent}
                    cleanup.commit()
                    pending.result(timeout=8)
                finally:
                    cleanup.rollback()
        assert world.remaining() == {recent}
        assert world.proofs()[0].event_metadata["retention_days"] == 365
