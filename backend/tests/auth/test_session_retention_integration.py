"""Committed global session maintenance, bounded proofs and real PostgreSQL locks."""

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event
from time import monotonic
from types import SimpleNamespace
from uuid import uuid4

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import event, func, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database.session import AuditSession, get_engine
from app.systems.access.identity.models import IdentityMfaObservation, IdentitySession
from app.systems.access.identity.provider_signout_worker import ProviderSignoutWorker
from app.systems.access.identity.session_revocation import revoke_user_sessions
from app.systems.access.users.models import User
from app.systems.manage.audit.models import AuditLog, SecurityEvent

pytestmark = pytest.mark.integration


@pytest.fixture
def world(integration_owner_db, request):
    owner = integration_owner_db.get_bind().engine
    runtime = get_engine()
    users = []
    events = []
    with Session(owner) as db:
        before = set(db.scalars(select(SecurityEvent.id)))

    def add_users(count=1):
        rows = [
            User(
                id=uuid4(),
                username=str(uuid4()),
                email=f"{uuid4()}@example.test",
                status="active",
                role="member",
            )
            for _ in range(count)
        ]
        users.extend(row.id for row in rows)
        with Session(owner) as db:
            db.add_all(rows)
            db.commit()
        return users[-count:]

    def add_sessions(fields):
        rows = [
            IdentitySession(
                id=uuid4(),
                user_id=item.pop("user_id", users[0]),
                refresh_token_digest=str(uuid4()),
                csrf_token_digest="owned",
                **item,
            )
            for item in fields
        ]
        ids = [row.id for row in rows]
        with Session(owner) as db:
            db.add_all(rows)
            db.commit()
        return ids

    def proofs():
        with Session(owner) as db:
            return list(
                db.scalars(
                    select(SecurityEvent).where(
                        SecurityEvent.source == "identity.session_retention",
                        SecurityEvent.id.not_in(before),
                    )
                )
            )

    def cleanup():
        with Session(owner) as db:
            for row in db.scalars(
                select(SecurityEvent).where(
                    (SecurityEvent.source == "identity.session_retention")
                    & SecurityEvent.id.not_in(before)
                    | SecurityEvent.id.in_(events)
                )
            ):
                db.delete(row)
            for row in db.scalars(select(User).where(User.id.in_(users))):
                db.delete(row)
            db.commit()

    # Registered before add_users() so a failed setup still cleans up.
    request.addfinalizer(cleanup)  # noqa: PT021
    add_users()
    return SimpleNamespace(
        owner=owner,
        runtime=runtime,
        users=users,
        events=events,
        add_users=add_users,
        add_sessions=add_sessions,
        proofs=proofs,
    )


def _remaining(world, ids):
    with Session(world.owner) as db:
        return set(db.scalars(select(IdentitySession.id).where(IdentitySession.id.in_(ids))))


def _retain(db):
    from app.systems.access.identity.session_retention import retain_terminal_sessions

    return retain_terminal_sessions(db)


def test_existing_worker_performs_due_committed_terminal_cleanup(world, monkeypatch):
    old = datetime.now(UTC) - timedelta(days=400)
    ids = world.add_sessions(
        [
            {"expires_at": old},
            {"expires_at": old, "provider_signout_pending_at": old, "provider_signout_attempts": 5},
        ]
    )
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
    assert _remaining(world, ids) == {ids[1]}
    assert len(world.proofs()) == 1


def test_bulk_revocation_holds_real_session_lock_before_mutating(world):
    ids = world.add_sessions([{"expires_at": datetime.now(UTC) - timedelta(days=400)}])
    with AuditSession(world.runtime) as writer, Session(world.runtime) as competitor:
        assert revoke_user_sessions(writer, world.users[0], except_session_id=None) == 1
        available = competitor.scalar(
            select(IdentitySession.id)
            .where(IdentitySession.id == ids[0])
            .with_for_update(skip_locked=True)
        )
        assert available is None, "Revocation must hold the session lock before mutations"
        writer.commit()
    assert _remaining(world, ids) == set(ids)


def test_exclusive_cutoff_exemptions_completion_anchor_and_minimal_atomic_proof(world):
    with AuditSession(world.runtime) as db:
        as_of = db.scalar(select(func.now()))
        cutoff, old = as_of - timedelta(days=365), as_of - timedelta(days=400)
        candidates = [
            {"expires_at": old},
            {"expires_at": as_of, "revoked_at": old},
            {
                "expires_at": old,
                "provider_signout_attempts": 2,
                "provider_signout_completed_at": old,
            },
            {"expires_at": cutoff},
            {"expires_at": as_of + timedelta(days=1)},
            {"expires_at": old, "provider_signout_pending_at": old},
            {"expires_at": old, "provider_signout_next_attempt_at": old},
            {"expires_at": old, "provider_signout_attempts": 5, "provider_signout_pending_at": old},
            {"expires_at": old, "provider_signout_attempts": 1},
            {
                "expires_at": old,
                "provider_signout_attempts": 2,
                "provider_signout_completed_at": as_of,
            },
            {"expires_at": old, "provider_signout_completed_at": cutoff},
            {"expires_at": old, "revoked_at": as_of},
        ]
        ids = world.add_sessions(candidates)
        marker = uuid4()
        with Session(world.owner) as owner:
            owner.add(
                SecurityEvent(
                    id=marker,
                    occurred_at=old,
                    event_type="owned.old",
                    outcome="success",
                    source="owned.retention.fixture",
                    operation_id=uuid4(),
                )
            )
            owner.add(IdentityMfaObservation(user_id=world.users[0]))
            owner.commit()
        world.events.append(marker)
        assert _retain(db) == 3
        assert _remaining(world, ids) == set(ids[3:])
    (proof,) = world.proofs()
    assert proof.event_type == "security.retention" and proof.outcome == "success"
    assert proof.actor_id is None and proof.subject_id is None and proof.labels == {}
    assert proof.event_metadata == {
        "scope": "identity_sessions",
        "retention_days": 365,
        "batch_limit": 1000,
        "as_of": as_of.isoformat(),
        "cutoff": cutoff.isoformat(),
        "deleted_sessions": 3,
    }
    assert proof.occurred_at == as_of and proof.operation_id is not None
    with Session(world.owner) as db:
        assert db.get(SecurityEvent, marker) is not None
        assert db.get(IdentityMfaObservation, world.users[0]) is not None
        assert not list(db.scalars(select(AuditLog).where(AuditLog.entity_id.in_(ids))))
    # The exact-cutoff rows become strictly older in a subsequent transaction.
    with AuditSession(world.runtime) as db:
        assert _retain(db) == 2
    assert _remaining(world, ids) == set(ids[4:10] + ids[11:])
    with AuditSession(world.runtime) as db:
        assert _retain(db) == 0
    assert len(world.proofs()) == 2


@pytest.mark.parametrize("stage", ["proof", "flush", "commit"])
def test_failed_maintenance_rolls_back_deletion_and_proof(world, monkeypatch, stage):
    from app.systems.access.identity import session_retention as retention

    ids = world.add_sessions([{"expires_at": datetime.now(UTC) - timedelta(days=400)}])
    with AuditSession(world.runtime) as db:

        def fail(*_args, **_kwargs):
            if stage == "commit":
                db.flush()
            raise SQLAlchemyError("Owned maintenance persistence failure")

        if stage == "proof":
            monkeypatch.setattr(retention, "append_security_event", fail)
        else:
            monkeypatch.setattr(db, stage, fail)
        with pytest.raises(SQLAlchemyError):
            _retain(db)
    assert _remaining(world, ids) == set(ids)
    assert world.proofs() == []


def test_advisory_overlap_and_locked_rows_are_skipped_without_persistent_noop(world):
    from app.systems.access.identity import session_retention as retention

    ids = world.add_sessions(
        [{"expires_at": datetime.now(UTC) - timedelta(days=400)} for _ in range(2)]
    )
    with Session(world.runtime) as blocker:
        assert blocker.scalar(select(func.pg_try_advisory_xact_lock(retention._LOCK_KEY)))
        with AuditSession(world.runtime) as db:
            assert _retain(db) == 0
        assert world.proofs() == []
        blocker.rollback()
        blocker.scalar(
            select(IdentitySession).where(IdentitySession.id == ids[0]).with_for_update()
        )
        with AuditSession(world.runtime) as db:
            assert _retain(db) == 1
        assert _remaining(world, ids) == {ids[0]}
        blocker.rollback()
    with AuditSession(world.runtime) as db:
        assert _retain(db) == 1
    assert _remaining(world, ids) == set()
    assert [p.event_metadata["deleted_sessions"] for p in world.proofs()] == [1, 1]


def test_worker_refuses_wrong_instance_before_terminal_deletion(world, monkeypatch):
    from app.systems.access.identity import provider_signout_worker as module

    ids = world.add_sessions([{"expires_at": datetime.now(UTC) - timedelta(days=400)}])

    def refuse(*_args, **_kwargs):
        raise RuntimeError("Owned identity refusal")

    monkeypatch.setattr(module, "assert_provider_instance", refuse)
    worker = ProviderSignoutWorker(get_settings())
    with pytest.raises(RuntimeError, match="Owned identity refusal"):
        worker._run_retention_once()
    assert _remaining(world, ids) == set(ids) and world.proofs() == []


def test_global_10k_plan_real_cap_backlog_empty_and_held_rows(world, request):
    from app.systems.access.identity import session_retention as retention

    world.add_users(99)
    now = datetime.now(UTC)
    old, recent = now - timedelta(days=400), now - timedelta(days=100)
    rows = []
    for index in range(10000):
        row = {"user_id": world.users[index % 100], "expires_at": now + timedelta(days=1)}
        if 5000 <= index < 6500:
            row.update(expires_at=recent)
        elif 6500 <= index < 8000:
            row.update(expires_at=old)
            if index % 2:
                row.update(revoked_at=old)
        elif 8000 <= index < 8500:
            row.update(
                expires_at=old,
                revoked_at=old,
                provider_signout_pending_at=old,
                provider_signout_next_attempt_at=old,
            )
        elif 8500 <= index < 9000:
            row.update(expires_at=old, provider_signout_pending_at=old, provider_signout_attempts=5)
        elif 9000 <= index < 9500:
            row.update(
                expires_at=old, provider_signout_completed_at=now, provider_signout_attempts=2
            )
        elif index >= 9750:
            row.update(expires_at=old, provider_signout_attempts=1)
        rows.append(row)
    ids = world.add_sessions(rows)
    with Session(world.owner) as db:
        db.execute(text("ANALYZE public.identity_sessions"))
        db.commit()
    plans = []

    def plan(label):
        with Session(world.runtime) as db:
            as_of = db.scalar(select(func.now()))
            query = retention._retention_statement(as_of - timedelta(days=365))
            compiled = str(
                query.compile(dialect=world.runtime.dialect, compile_kwargs={"literal_binds": True})
            )
            assert "user_id =" not in compiled and "WHERE" in compiled
            result = db.scalar(text("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + compiled))
            plans.append(
                {
                    "label": label,
                    "sql": compiled,
                    "plan": result,
                    "statement_timeout": db.scalar(text("SHOW statement_timeout")),
                    "enable_seqscan": db.scalar(text("SHOW enable_seqscan")),
                    "runtime_role": db.scalar(select(func.current_user())),
                    "server_version": db.scalar(text("SHOW server_version")),
                    "global_sessions": db.scalar(select(func.count()).select_from(IdentitySession)),
                }
            )
            assert plans[-1]["runtime_role"] == "openslate_runtime"
            db.rollback()

    plan("backlog_1500")
    with AuditSession(world.runtime) as db:
        assert _retain(db) == 1000
    remaining = _remaining(world, ids[6500:8000])
    assert remaining == set(sorted(ids[6500:8000])[1000:])
    with Session(world.runtime) as blocker:
        held = next(iter(remaining))
        blocker.scalar(select(IdentitySession).where(IdentitySession.id == held).with_for_update())
        plan("sparse_500_with_one_locked")
        with AuditSession(world.runtime) as db:
            assert _retain(db) == 499
        blocker.rollback()
    with AuditSession(world.runtime) as db:
        assert _retain(db) == 1
    plan("empty_backlog")
    with AuditSession(world.runtime) as db:
        assert _retain(db) == 0
    assert len(_remaining(world, ids)) == 8500
    assert [p.event_metadata["deleted_sessions"] for p in world.proofs()] == [1000, 499, 1]
    request.node.user_properties.append(
        (
            "retention_plans",
            json.dumps(
                {
                    "seeded_users": 100,
                    "seeded_sessions": 10000,
                    "plans": plans,
                    "committed_counts": [1000, 499, 1, 0],
                }
            ),
        )
    )


pytest_plugins = ("tests.auth.session_policy_support",)


def test_mfa_and_bulk_revocation_complete_without_deadlock(policy_world, request):
    world = policy_world
    engine = get_engine()
    world.policy(session_concurrent_limit=4, mfa_require_admin=True)
    world.factor_status = "verified"
    a, z = world.session_ids[0], world.session_ids[3]
    assert a < z
    with Session(world.owner) as db:
        db.get(User, world.actor_id).mfa_required_since = world.clock
        cipher = Fernet(get_settings().supabase_session_encryption_key.get_secret_value().encode())
        db.get(IdentitySession, a).provider_access_token_encrypted = cipher.encrypt(
            world.access("aal2", slot=0).encode()
        ).decode()
        db.commit()
    entered, release, bulk_query, cap_query = Event(), Event(), Event(), Event()
    facts, states, pids = [], [], {}

    def held_provider(call):
        if call.url.path.endswith("/challenge"):
            entered.set()
            assert release.wait(15), "Owned MFA provider gate did not release"
        return None

    def before(connection, cursor, statement, _parameters, _context, _many):
        if "FROM users" in statement and "FOR UPDATE OF users" in statement:
            connection.info["13c_phase"] = "mfa"
            pids["mfa"] = cursor.connection.info.backend_pid
        if "FOR UPDATE" in statement or "FOR SHARE" in statement:
            if connection.info.get("13c_phase") == "bulk":
                bulk_query.set()
            elif "ORDER BY identity_sessions.created_at" in statement:
                cap_query.set()

    def error(context):
        state = getattr(context.original_exception, "sqlstate", None)
        if state:
            states.append(state)

    def revoke():
        with AuditSession(engine) as db:
            info = db.connection().info
            info["13c_phase"] = "bulk"
            pids["bulk"] = db.scalar(select(func.pg_backend_pid()))
            try:
                changed = revoke_user_sessions(db, world.actor_id, except_session_id=a)
                db.commit()
                return {"committed": True, "changed": changed}
            except SQLAlchemyError as failure:
                db.rollback()
                return {"committed": False, "sqlstate": getattr(failure.orig, "sqlstate", None)}
            finally:
                info.pop("13c_phase", None)

    world.hook = held_provider
    event.listen(engine, "before_cursor_execute", before)
    event.listen(engine, "handle_error", error)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(
                world.client.post,
                f"/api/auth/mfa/factors/{world.factor_id}/verification",
                headers=world.headers(slot=3),
                json={"code": "123456"},
            )
            assert entered.wait(15), "Real MFA request did not reach locked challenge"
            second = pool.submit(revoke)
            assert bulk_query.wait(15), "Bulk lock query was not submitted"
            deadline = monotonic() + 10
            with Session(engine) as monitor:
                while monotonic() < deadline:
                    wait = monitor.execute(
                        text(
                            "SELECT wait_event_type, pg_blocking_pids(pid) "
                            "FROM pg_stat_activity WHERE pid=:pid"
                        ),
                        {"pid": pids["bulk"]},
                    ).one()
                    if wait[0] == "Lock" and pids["mfa"] in wait[1]:
                        available = monitor.scalar(
                            select(IdentitySession.id)
                            .where(IdentitySession.id == a)
                            .with_for_update(skip_locked=True)
                        )
                        facts.append(
                            {"bulk_waits_for_mfa": True, "sibling_locked": available is None}
                        )
                        monitor.rollback()
                        break
                    monitor.rollback()
                assert facts, "Actual PostgreSQL wait was not established"
            release.set()
            response, bulk = first.result(timeout=25), second.result(timeout=25)
        observations = {
            "waits": facts,
            "sqlstates": states,
            "mfa_status": response.status_code,
            "cap_requested": cap_query.is_set(),
            "bulk": bulk,
        }
        request.node.user_properties.append(("mfa_bulk_concurrency", json.dumps(observations)))
        assert "40P01" not in states, observations
        assert cap_query.is_set() and response.status_code == 200, observations
        assert bulk == {"committed": True, "changed": 3}, observations
        with Session(world.owner) as db:
            assert db.get(IdentitySession, a).revoked_at is None
            assert all(
                db.get(IdentitySession, sid).revoked_at is not None for sid in world.session_ids[1:]
            )
    finally:
        release.set()
        event.remove(engine, "before_cursor_execute", before)
        event.remove(engine, "handle_error", error)
