"""Committed claims and canonical session locks require independent PG connections."""

import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.config.instance import instance_target_for_process
from app.core.database.session import AuditSession
from app.main import create_app
from app.systems.access.users.models import Membership, UserRole
from app.systems.manage.backups import service
from app.systems.manage.backups.models import BackupPolicy, BackupRun
from app.systems.manage.backups.schemas import InspectCommand
from app.systems.manage.workspace.models import PlatformSettings, WorkspaceProfile
from operations.backup_state import coordinated_session, execute
from operations.reset.models import _RESET_ADVISORY_LOCK_KEY
from tests.conftest import guarded_create_engine, make_operator
from tests.race_support import backend_pid, join, start, wait_until_blocked_by
from tests.rbac.support import _client, add_user, organization

pytestmark = pytest.mark.integration


def test_absent_backup_policy_creation_is_serialized_by_installation_settings() -> None:
    engine = guarded_create_engine(os.environ["TEST_DATABASE_URL"])
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    policy_id = None
    worker = None
    try:
        with AuditSession(engine, expire_on_commit=False) as first:
            instance = service.installation_id(first)
            policy = service.lock_policy(first, instance)
            policy_id = policy.id

            def create_policy():
                with AuditSession(engine) as second:
                    result = service.lock_policy(second, instance).id
                    second.commit()
                    return result

            worker, results = start(create_policy)
            try:
                wait_until_blocked_by(owner, backend_pid(first))
            finally:
                first.commit()
            assert join(worker, results) == policy_id
        with Session(engine) as observer:
            assert observer.scalars(select(BackupPolicy.id)).all() == [policy_id]
            assert observer.scalar(select(PlatformSettings.id)) is not None
    finally:
        if worker is not None:
            worker.join(10)
        if policy_id is not None:
            with owner.begin() as cleanup:
                cleanup.execute(text("DELETE FROM audit_logs WHERE entity_id = :id"),
                                {"id": policy_id})
                cleanup.execute(BackupPolicy.__table__.delete().where(BackupPolicy.id == policy_id))
        engine.dispose()
        owner.dispose()


def test_concurrent_lost_response_replay_commits_only_one_request() -> None:
    engine = guarded_create_engine(os.environ["TEST_DATABASE_URL"])
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    actor = None
    created_policy = False
    try:
        with AuditSession(engine, expire_on_commit=False) as db:
            created_policy = db.scalar(select(BackupPolicy.id)) is None
            actor = make_operator(db, add_user(db, role=UserRole.ADMIN))
            org_id = organization(db).id
            db.commit()
        gate, key = Barrier(3), uuid4().hex

        def request():
            with AuditSession(engine) as db:
                client = _client(create_app(), actor, db)
                gate.wait(timeout=10)
                response = client.post(
                    "/api/backups",
                    json={"name": "Concurrent replay"},
                    headers={"Idempotency-Key": key},
                )
                return response.status_code, response.json()

        with ThreadPoolExecutor(max_workers=2) as workers:
            pending = [workers.submit(request) for _ in range(2)]
            gate.wait(timeout=10)
            results = [job.result(timeout=20) for job in pending]
        assert [status for status, _ in results] == [201, 201]
        assert results[0][1]["id"] == results[1][1]["id"]
        with AuditSession(engine) as db:
            rows = db.scalars(select(BackupRun).where(BackupRun.requester_id == actor.id)).all()
            assert len(rows) == 1 and rows[0].state == "queued"
    finally:
        with Session(owner) as db:
            if actor is not None:
                for run in db.scalars(
                    select(BackupRun).where(BackupRun.requester_id == actor.id)
                ).all():
                    db.delete(run)
            if created_policy:
                policy = db.scalar(select(BackupPolicy))
                if policy is not None:
                    db.delete(policy)
            if actor is not None:
                db.connection().execute(text("DELETE FROM audit_logs WHERE org_id = :id"),
                                        {"id": org_id})
                for membership in db.scalars(select(Membership).where(
                    Membership.user_id == actor.id
                )):
                    db.delete(membership)
                db.connection().execute(
                    text("DELETE FROM platform_operators WHERE user_id = :id"), {"id": actor.id}
                )
                db.flush()
                db.delete(db.get(type(actor), actor.id))
                db.flush()
                db.delete(db.get(WorkspaceProfile, org_id))
            db.commit()
        engine.dispose()
        owner.dispose()


def test_reset_lock_claim_commit_exact_reconciliation_and_rollback() -> None:
    runtime = os.environ["TEST_DATABASE_URL"]
    target = instance_target_for_process(runtime, "openslate_runtime")
    assert target is not None
    instance = target.instance_id
    engine = guarded_create_engine(runtime)
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    actor = None
    created_policy = False
    try:
        with AuditSession(engine, expire_on_commit=False) as db:
            created_policy = db.scalar(select(BackupPolicy.id)) is None
            actor = make_operator(db, add_user(db, role=UserRole.ADMIN))
            org_id = organization(db).id
            run = service.queue_manual(db, instance, actor.id, "Coordinated", uuid4().hex)
            db.commit()
            run_id = run.id
        with engine.connect() as reset_connection:
            reset_connection.execute(
                text("SELECT pg_advisory_lock(:key)"), {"key": _RESET_ADVISORY_LOCK_KEY}
            )
            reset_connection.commit()
            try:
                with pytest.raises(service.BackupStateError, match="backup_coordination_busy"):
                    with coordinated_session(engine, target):
                        pytest.fail("Claim entered while reset retained its lock")
                with AuditSession(engine) as db:
                    assert db.get(BackupRun, run_id).state == "queued"
            finally:
                reset_connection.execute(
                    text("SELECT pg_advisory_unlock(:key)"), {"key": _RESET_ADVISORY_LOCK_KEY}
                )
                reset_connection.commit()

        def claim_then_cancel(db: Session) -> None:
            service.claim_run(db, instance, uuid4())
            raise RuntimeError("cancelled")

        with pytest.raises(RuntimeError, match="cancelled"):
            with coordinated_session(engine, target) as db:
                claim_then_cancel(db)
        with AuditSession(engine) as db:
            assert db.get(BackupRun, run_id).state == "queued"
            assert service.unresolved_run(db, instance) is None
        claim_id = uuid4()
        with coordinated_session(engine, target) as db:
            backend_pid = db.connection().scalar(text("SELECT pg_backend_pid()"))
            assert backend_pid is not None
            assert (
                db.connection().scalar(
                    text(
                        "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' "
                        "AND pid = pg_backend_pid() AND objid = :key AND granted)"
                    ),
                    {"key": _RESET_ADVISORY_LOCK_KEY},
                )
                is True
            )
            assert service.claim_run(db, instance, claim_id).id == run_id
        with AuditSession(engine) as db:
            assert service.unresolved_run(db, instance).id == run_id
            # Lost claim acknowledgement can reveal the exact run using just claim_id.
            state = execute(
                db,
                InspectCommand(
                    op="inspect",
                    installation_id=instance,
                    project="host-admitted-project",
                    claim_id=claim_id,
                ),
            )
            assert state["claim"]["run"]["id"] == str(run_id)
            assert state["unresolved"]["claim_id"] == str(claim_id)
            assert state["retention_candidates"] == []
        with pytest.raises(service.BackupStateError, match="backup_recovery_required"):
            with coordinated_session(engine, target) as db:
                service.claim_run(db, instance, uuid4())
        with engine.connect() as observer:
            assert (
                observer.scalar(
                    text("SELECT pg_try_advisory_lock(:key)"), {"key": _RESET_ADVISORY_LOCK_KEY}
                )
                is True
            )
            assert (
                observer.scalar(
                    text("SELECT pg_advisory_unlock(:key)"), {"key": _RESET_ADVISORY_LOCK_KEY}
                )
                is True
            )
            observer.rollback()
    finally:
        with Session(owner) as db:
            if actor is not None:
                for run in db.scalars(
                    select(BackupRun).where(BackupRun.requester_id == actor.id)
                ).all():
                    db.delete(run)
            if created_policy:
                policy = db.scalar(select(BackupPolicy))
                if policy is not None:
                    db.delete(policy)
            if actor is not None:
                db.connection().execute(text("DELETE FROM audit_logs WHERE org_id = :id"),
                                        {"id": org_id})
                for membership in db.scalars(select(Membership).where(
                    Membership.user_id == actor.id
                )):
                    db.delete(membership)
                db.connection().execute(
                    text("DELETE FROM platform_operators WHERE user_id = :id"), {"id": actor.id}
                )
                db.flush()
                db.delete(db.get(type(actor), actor.id))
                db.flush()
                db.delete(db.get(WorkspaceProfile, org_id))
            db.commit()
        engine.dispose()
        owner.dispose()
