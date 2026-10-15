"""Configured terminal-session cutoff, policy locks and durable history protection."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event
from time import monotonic

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.core.database.session import AuditSession
from app.systems.access.identity.models import IdentityMfaObservation
from app.systems.access.identity.session_retention import retain_terminal_sessions
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.auth.session_retention_support import world as world

pytestmark = pytest.mark.integration
FIELDS = ("session_retention_days", "security_event_retention_days")


@pytest.fixture
def configured_world(world):
    with Session(world.owner) as db:
        profile = db.scalar(select(WorkspaceProfile))
        before = {field: getattr(profile, field) for field in FIELDS}
    try:
        yield world
    finally:
        with Session(world.owner) as db:
            profile = db.scalar(select(WorkspaceProfile))
            for field, value in before.items():
                setattr(profile, field, value)
            db.commit()


def _policy(world, **fields):
    with Session(world.owner) as db:
        profile = db.scalar(select(WorkspaceProfile))
        for field, value in fields.items():
            setattr(profile, field, value)
        db.commit()


def _remaining(world, ids):
    from app.systems.access.identity.models import IdentitySession

    with Session(world.owner) as db:
        return set(db.scalars(select(IdentitySession.id).where(IdentitySession.id.in_(ids))))


def _retain(world):
    with AuditSession(world.runtime) as db:
        return retain_terminal_sessions(db)


def _wait_policy(owner, holder_pid):
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
    raise AssertionError("Policy contender did not reach its real database lock")


def test_nondefault_session_period_uses_db_cutoff_and_keeps_history(configured_world):
    world = configured_world
    _policy(world, session_retention_days=14, security_event_retention_days=1)
    with AuditSession(world.runtime) as db:
        as_of = db.scalar(select(func.now())).astimezone(UTC)
        ids = world.add_sessions(
            [
                {"expires_at": as_of - timedelta(days=15)},
                {"expires_at": as_of - timedelta(days=14)},
                {"expires_at": as_of + timedelta(days=1)},
                {
                    "expires_at": as_of - timedelta(days=400),
                    "provider_signout_pending_at": as_of - timedelta(days=400),
                    "provider_signout_attempts": 5,
                },
            ]
        )
        with Session(world.owner) as owner:
            history = IdentityMfaObservation(
                user_id=world.users[0],
                last_sign_in_at=as_of - timedelta(days=100),
                last_active_at=as_of - timedelta(days=20),
            )
            owner.add(history)
            owner.commit()
        assert retain_terminal_sessions(db) == 1
    assert _remaining(world, ids) == set(ids[1:])
    (proof,) = world.proofs()
    assert proof.event_metadata["retention_days"] == 14
    assert proof.event_metadata["as_of"] == as_of.isoformat()
    assert proof.event_metadata["cutoff"] == (as_of - timedelta(days=14)).isoformat()
    with Session(world.owner) as db:
        row = db.get(IdentityMfaObservation, world.users[0])
        assert row.last_sign_in_at == as_of - timedelta(days=100)
        assert row.last_active_at == as_of - timedelta(days=20)


@pytest.mark.parametrize("first", ["writer", "cleanup"])
def test_session_cleanup_and_policy_writer_serialize(configured_world, first, monkeypatch):
    world = configured_world
    old, recent = world.add_sessions(
        [
            {"expires_at": datetime.now(UTC) - timedelta(days=400)},
            {"expires_at": datetime.now(UTC) - timedelta(days=10)},
        ]
    )
    if first == "writer":
        with world.owner.connect() as writer:
            transaction = writer.begin()
            holder_pid = writer.scalar(text("SELECT pg_backend_pid()"))
            writer.execute(text("UPDATE public.workspace_profiles SET session_retention_days=1"))
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(_retain, world)
                try:
                    _wait_policy(world.owner, holder_pid)
                    transaction.commit()
                    assert pending.result(timeout=8) == 2
                finally:
                    if transaction.is_active:
                        transaction.rollback()
        assert not _remaining(world, [old, recent])
        assert world.proofs()[0].event_metadata["retention_days"] == 1
    else:
        from app.systems.access.identity import session_retention

        entered, release = Event(), Event()
        holder = []
        original = session_retention.append_security_event

        def hold_proof(db, payload):
            result = original(db, payload)
            holder.append(db.scalar(select(func.pg_backend_pid())))
            entered.set()
            assert release.wait(10), "Policy contender never reached the cleanup lock"
            return result

        monkeypatch.setattr(session_retention, "append_security_event", hold_proof)
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                cleanup = pool.submit(_retain, world)
                assert entered.wait(8), "Cleanup never reached its real proof/commit boundary"
                writer = pool.submit(_policy, world, session_retention_days=1)
                _wait_policy(world.owner, holder[0])
                assert _remaining(world, [old, recent]) == {old, recent}
                release.set()
                assert cleanup.result(timeout=8) == 1
                writer.result(timeout=8)
        finally:
            release.set()
        assert _remaining(world, [old, recent]) == {recent}
        assert world.proofs()[0].event_metadata["retention_days"] == 365


def test_event_overlap_does_not_suppress_independent_session_pass(configured_world):
    world = configured_world
    with AuditSession(world.runtime) as event_transaction:
        assert event_transaction.scalar(select(func.public.retain_security_events())) == 0
        ids = world.add_sessions([{"expires_at": datetime.now(UTC) - timedelta(days=400)}])
        assert _retain(world) == 1
        assert not _remaining(world, ids)
        event_transaction.rollback()
