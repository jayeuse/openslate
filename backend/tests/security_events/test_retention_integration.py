"""Real runtime capability: fixed proofs, rollback, cutoff and committed lock races."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event
from time import monotonic
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import Response
from sqlalchemy import event, func, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from starlette.requests import Request

from app.common.dependencies.auth import CurrentIdentity
from app.core.config import get_settings
from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession, get_engine
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.provider_signout_worker import ProviderSignoutWorker
from app.systems.access.users.models import Membership, PlatformOperator, User
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditLog, SecurityEvent
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.workspace.models import PlatformSettings, WorkspaceProfile
from app.systems.manage.workspace.security_router import update_workspace_security
from app.systems.manage.workspace.security_schemas import WorkspaceSecurityUpdate
from tests.conftest import create_member, create_organization, make_operator
from tests.race_support import WAIT

pytestmark = pytest.mark.integration
FIELDS = ("session_retention_days", "security_event_retention_days")


@pytest.fixture
def event_retention_world(integration_owner_db):
    owner, runtime = integration_owner_db.get_bind().engine, get_engine()
    ids = []
    organizations = []
    with Session(owner) as db:
        before = set(db.scalars(select(SecurityEvent.id)))
        profile = db.scalar(select(PlatformSettings))
        original = {field: getattr(profile, field) for field in FIELDS if hasattr(profile, field)}

    def add(times, *, org_id=None):
        rows = [
            SecurityEvent(
                id=uuid4(),
                org_id=org_id,
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

    def organization(days):
        with Session(owner) as db:
            org = create_organization(db, security_event_retention_days=days)
            organizations.append(org.id)
            db.commit()
            return org.id

    try:
        yield SimpleNamespace(
            owner=owner,
            runtime=runtime,
            add=add,
            proofs=proofs,
            remaining=remaining,
            policy=policy,
            ids=ids,
            organization=organization,
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
            db.flush()
            for org_id in organizations:
                db.delete(db.get(WorkspaceProfile, org_id))
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


def test_retention_uses_each_organization_not_platform_or_bound_scope(event_retention_world):
    world = event_retention_world
    a, b = world.organization(365), world.organization(7)
    world.policy(security_event_retention_days=30)
    with AuditSession(world.runtime) as db:
        scope_session(db, a)
        as_of = db.scalar(select(func.now())).astimezone(UTC)
        a_rows = world.add([as_of - timedelta(days=60), as_of - timedelta(days=366)], org_id=a)
        b_rows = world.add([as_of - timedelta(days=7), as_of - timedelta(days=8)], org_id=b)
        platform = world.add([as_of - timedelta(days=30), as_of - timedelta(days=31)])
        assert db.scalar(select(func.public.retain_security_events())) == 3
        db.commit()
    assert world.remaining() == {a_rows[0], b_rows[0], platform[0]}
    proofs = {row.org_id: row for row in world.proofs()}
    assert set(proofs) == {a, b, None}
    for org_id, days in ((a, 365), (b, 7), (None, 30)):
        proof = proofs[org_id]
        assert proof.event_metadata["retention_days"] == days
        assert proof.event_metadata["deleted_events"] == 1
        assert datetime.fromisoformat(proof.event_metadata["cutoff"]) == (
            as_of - timedelta(days=days)
        )


def test_mixed_scope_deletion_keeps_one_global_batch_bound(event_retention_world):
    world = event_retention_world
    a, b = world.organization(365), world.organization(7)
    old = datetime.now(UTC) - timedelta(days=400)
    world.add([old - timedelta(seconds=i * 2) for i in range(501)], org_id=a)
    world.add([old - timedelta(seconds=i * 2 + 1) for i in range(501)], org_id=b)
    assert _invoke(world) == 1000
    assert len(world.remaining()) == 2
    assert sum(row.event_metadata["deleted_events"] for row in world.proofs()) == 1000
    assert {row.org_id for row in world.proofs()} == {a, b}


@pytest.mark.parametrize("first", ["writer", "cleanup"])
def test_organization_policy_and_cleanup_serialize(event_retention_world, first):
    world = event_retention_world
    org_id = world.organization(365)
    old, recent = world.add(
        [datetime.now(UTC) - timedelta(days=400), datetime.now(UTC) - timedelta(days=10)],
        org_id=org_id,
    )

    def change_policy():
        with Session(world.owner) as db:
            db.get(WorkspaceProfile, org_id).security_event_retention_days = 1
            db.commit()

    with world.owner.connect() as writer, AuditSession(world.runtime) as cleanup:
        holder = writer if first == "writer" else cleanup
        pid = holder.scalar(select(func.pg_backend_pid()))
        if first == "writer":
            writer.execute(text(
                "UPDATE public.organizations SET security_event_retention_days=1 WHERE id=:id"
            ), {"id": org_id})
        else:
            assert cleanup.scalar(select(func.public.retain_security_events())) == 1
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = (
                pool.submit(_invoke, world) if first == "writer" else pool.submit(change_policy)
            )
            try:
                _wait_for_policy_lock(world.owner, pid)
                holder.commit()
                result = pending.result(timeout=8)
                if first == "writer":
                    assert result == 2
            finally:
                holder.rollback()
    assert world.remaining() == (set() if first == "writer" else {recent})
    assert old not in world.remaining()


def test_actual_two_row_security_writer_and_retention_complete_without_deadlock(
    event_retention_world,
):
    world = event_retention_world
    org_id = world.organization(365)
    org_rows = world.add(
        [datetime.now(UTC) - timedelta(days=400), datetime.now(UTC) - timedelta(days=10)],
        org_id=org_id,
    )
    world.add([datetime.now(UTC) - timedelta(days=400), datetime.now(UTC) - timedelta(days=10)])
    with Session(world.owner) as db:
        org = db.get(WorkspaceProfile, org_id)
        actor, membership = create_member(db, org, "admin")
        make_operator(db, actor)
        org.owner_user_id = actor.id
        session = IdentitySession(
            user_id=actor.id, refresh_token_digest=uuid4().hex * 2,
            csrf_token_digest=uuid4().hex * 2, expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        db.add(session)
        db.flush()
        actor_id, membership_id, session_id, revision = (
            actor.id, membership.id, session.id, org.revision,
        )
        platform = db.scalar(select(PlatformSettings))
        platform_before = platform.revision, platform.performed_by
        db.commit()
    paused, release = Event(), Event()
    holder = []

    def pause_after_first_policy_lock(_connection, cursor, statement, *_args):
        # Synchronize the real writer regardless of which of its two rows it locks first.
        if paused.is_set() or "FOR UPDATE" not in statement or not any(
            f"FROM {table}" in statement for table in ("organizations", "platform_settings")
        ):
            return
        holder.append(cursor.connection.info.backend_pid)
        paused.set()
        assert release.wait(WAIT), "The real two-row policy writer was not released"

    def change_policy():
        with AuditSession(world.runtime) as db:
            scope_session(db, org_id)
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(performed_by=actor_id)
            user = db.get(User, actor_id)
            return update_workspace_security(
                WorkspaceSecurityUpdate(revision=revision, security_event_retention_days=1),
                Request({"type": "http", "method": "PATCH", "path": "/api/workspace/security"}),
                CurrentIdentity(user, session_id, False, False), user, db, Response(),
            )

    event.listen(world.runtime, "after_cursor_execute", pause_after_first_policy_lock)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            writer = pool.submit(change_policy)
            try:
                assert paused.wait(WAIT), "The real writer did not acquire its first policy row"
                cleanup = pool.submit(_invoke, world)
                _wait_for_policy_lock(world.owner, holder[0])
            finally:
                release.set()
            # Either deadlock victim is a failure: the writer must not return 503 and
            # retention must not roll back instead of producing its committed proof.
            assert writer.result(timeout=WAIT).security_event_retention_days == 1
            assert cleanup.result(timeout=WAIT) == 3
        assert world.remaining() == {org_rows[1]}
        proofs = {row.org_id: row.event_metadata for row in world.proofs()}
        assert set(proofs) == {org_id, None}
        assert (proofs[org_id]["retention_days"], proofs[org_id]["deleted_events"]) == (365, 1)
        assert (proofs[None]["retention_days"], proofs[None]["deleted_events"]) == (1, 2)
        with Session(world.owner) as db:
            assert db.get(WorkspaceProfile, org_id).revision == revision + 1
            assert db.scalar(select(PlatformSettings)).security_event_retention_days == 1
    finally:
        release.set()
        event.remove(world.runtime, "after_cursor_execute", pause_after_first_policy_lock)
        with Session(world.owner) as db:
            for model, condition in (
                (AuditLog, AuditLog.performed_by == actor_id),
                (SecurityEvent, SecurityEvent.actor_id == actor_id),
                (PlatformOperator, PlatformOperator.user_id == actor_id),
            ):
                for row in db.scalars(select(model).where(condition)):
                    db.delete(row)
            db.delete(db.get(IdentitySession, session_id))
            db.delete(db.get(Membership, membership_id))
            db.get(WorkspaceProfile, org_id).owner_user_id = None
            platform = db.scalar(select(PlatformSettings))
            platform.revision, platform.performed_by = platform_before
            db.flush()
            db.delete(db.get(User, actor_id))
            db.commit()


@pytest.mark.parametrize("failure", ["outer_rollback", "proof_insert", "organization_proof_insert"])
def test_deletion_and_fixed_proof_roll_back_together(event_retention_world, failure):
    world = event_retention_world
    old = world.add([datetime.now(UTC) - timedelta(days=400)])
    if failure == "organization_proof_insert":
        old += world.add([datetime.now(UTC) - timedelta(days=400)], org_id=world.organization(30))
    if failure == "outer_rollback":
        assert _invoke(world, commit=False) == 1
    else:
        with world.owner.begin() as connection:
            connection.execute(
                text(
                    "ALTER TABLE public.security_events ADD CONSTRAINT "
                    "owned_retention_proof_failure "
                    "CHECK(source <> 'security.event_retention' "
                    + ("OR org_id IS NULL" if failure == "organization_proof_insert" else "")
                    + ") NOT VALID"
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
