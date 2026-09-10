"""Durable queue authorization, retries and conservative engine recovery."""

from datetime import UTC, datetime, timedelta
from hashlib import sha256
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.systems.files import service
from app.systems.files.models import File
from app.systems.files.providers import (
    ProviderUnavailable,
    ScannerExecutionUncertain,
    ScannerPolicyRejected,
    ScanVerdict,
)
from app.systems.files.scan_processing import WorkerHalted, process_next
from app.systems.files.worker import acknowledge_engine_replacement
from tests.files.test_integration import Store, reserve

pytestmark = pytest.mark.integration


class Scanner:
    def __init__(self, db):
        self.db = db
        self.calls = 0
        self.probe_failure = False
        self.failure = None
        self.during_scan = None

    def probe(self):
        assert not self.db.in_transaction()
        if self.probe_failure:
            raise ProviderUnavailable("offline before submission")

    def scan(self, content, *, digest, operation_id):
        assert not self.db.in_transaction()
        self.calls += 1
        if self.during_scan:
            self.during_scan()
        if self.failure:
            raise self.failure
        return ScanVerdict("clean", sha256(content).hexdigest(), "test-engine", "test-signatures")


def uploaded(db, actor):
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    service.upload(db, actor_id, file_id, content, storage)
    return file_id, storage


def test_upload_queues_and_idempotent_request_does_not_reset_requester_or_attempts(
    guarded_db, actor
):
    db = guarded_db
    actor_id = actor.id
    file_id, storage = uploaded(db, actor)
    file = db.get(File, file_id)
    assert file.scan_requested_by == actor_id and file.scan_next_attempt_at is not None
    original_due = file.scan_next_attempt_at
    service.scan(db, actor_id, file_id)
    assert db.get(File, file_id).scan_next_attempt_at == original_due
    assert process_next(db, storage, Scanner(db)) is True
    file = db.get(File, file_id)
    assert file.state == "ready" and file.scan_attempts == 1
    assert file.performed_by is None


def test_readiness_wait_consumes_no_attempt_then_retries_follow_exact_schedule(guarded_db, actor):
    db = guarded_db
    file_id, storage = uploaded(db, actor)
    scanner = Scanner(db)
    scanner.probe_failure = True
    assert process_next(db, storage, scanner) is False
    assert db.get(File, file_id).scan_attempts == 0
    scanner.probe_failure = False
    scanner.failure = ProviderUnavailable("known completed/no submitted execution")
    now = datetime.now(UTC)
    for attempt, delay in enumerate([30, 120, 600, 1800, None], start=1):
        assert process_next(db, storage, scanner, clock=lambda instant=now: instant) is True
        file = db.get(File, file_id)
        assert file.scan_attempts == attempt
        assert file.operation_id is None
        if delay is None:
            assert file.failure_code == "scan_exhausted" and file.scan_next_attempt_at is None
        else:
            assert file.scan_next_attempt_at == now + timedelta(seconds=delay)
            assert process_next(db, storage, scanner, clock=lambda instant=now: instant) is False
            now += timedelta(seconds=delay)
    assert scanner.calls == 5


def test_uncertain_execution_halts_and_api_cannot_clear_it(guarded_db, actor):
    db = guarded_db
    actor_id = actor.id
    file_id, storage = uploaded(db, actor)
    scanner = Scanner(db)
    scanner.failure = ScannerExecutionUncertain("submitted execution unknown")
    with pytest.raises(WorkerHalted):
        process_next(db, storage, scanner)
    file = db.get(File, file_id)
    operation_id = file.operation_id
    assert file.failure_code == "scan_execution_unresolved" and operation_id is not None
    for request in [
        lambda: service.scan(db, actor_id, file_id),
        lambda: service.reconcile(db, actor_id, file_id, storage),
    ]:
        with pytest.raises(HTTPException) as caught:
            request()
        assert caught.value.detail["code"] == "scan_execution_unresolved"
        db.rollback()
    with pytest.raises(WorkerHalted):
        process_next(db, storage, scanner)
    assert scanner.calls == 1
    assert acknowledge_engine_replacement(db) == 1
    assert db.get(File, file_id).scan_attempts == 1
    assert db.get(File, file_id).operation_id is None
    scanner.failure = None
    assert process_next(db, storage, scanner)
    assert db.get(File, file_id).state == "ready"


def test_revoked_requester_suspends_without_engine_access_and_new_actor_can_adopt(
    guarded_db, actor
):
    from sqlalchemy import select, text

    from app.systems.users.models import Role, User

    db = guarded_db
    original_id = actor.id
    file_id, storage = uploaded(db, actor)
    actor.status = "disabled"
    db.commit()
    scanner = Scanner(db)
    assert process_next(db, storage, scanner) is False
    assert scanner.calls == 0 and db.get(File, file_id).failure_code == "scan_suspended"
    new_id = uuid4()
    db.connection().execute(
        text("INSERT INTO auth.users (id,email) VALUES (:id,:email)"),
        {"id": new_id, "email": f"queue-{new_id}@example.com"},
    )
    replacement = db.get(User, new_id)
    replacement.role_id = db.scalar(select(Role.id).where(Role.role == "admin"))
    replacement.status = "active"
    replacement.invitation_sent_at = None
    db.commit()
    service.scan(db, new_id, file_id)
    assert db.get(File, file_id).creator_id == original_id
    assert db.get(File, file_id).scan_requested_by == new_id
    assert process_next(db, storage, scanner)
    assert db.get(File, file_id).state == "ready"


@pytest.mark.parametrize("change", ["archive", "revoke", "expire", "digest"])
def test_finalization_rechecks_authority_identity_and_lease(guarded_db, actor, change):
    db = guarded_db
    file_id, storage = uploaded(db, actor)
    scanner = Scanner(db)

    def changed():
        file = db.get(File, file_id)
        if change == "archive":
            file.is_deleted = True
        elif change == "revoke":
            actor.status = "disabled"
        elif change == "expire":
            file.operation_expires_at = datetime.now(UTC) - timedelta(seconds=1)
        else:
            file.digest = "0" * 64
        db.commit()

    scanner.during_scan = changed
    if change in {"expire", "digest"}:
        with pytest.raises(WorkerHalted):
            process_next(db, storage, scanner)
    else:
        assert process_next(db, storage, scanner)
    assert db.get(File, file_id).state == "pending_scan"


@pytest.mark.parametrize("failure", ["integrity", "policy"])
def test_integrity_and_policy_failures_are_terminal(guarded_db, actor, failure):
    db = guarded_db
    file_id, storage = uploaded(db, actor)
    scanner = Scanner(db)
    if failure == "integrity":
        storage.objects[db.get(File, file_id).object_key] = b"changed"
    else:
        scanner.failure = ScannerPolicyRejected("encrypted or exceeds inspection limits")
    assert process_next(db, storage, scanner)
    file = db.get(File, file_id)
    assert file.state == "rejected"
    assert file.failure_code == (
        "scan_integrity_error" if failure == "integrity" else "scan_policy_rejected"
    )
    assert file.scan_next_attempt_at is None


def test_invalid_verdict_is_unresolved_and_never_retried_automatically(guarded_db, actor):
    db = guarded_db
    file_id, storage = uploaded(db, actor)

    class BadVerdict(Scanner):
        def scan(self, content, *, digest, operation_id):
            return ScanVerdict("clean", "wrong-digest", "test", "test")

    with pytest.raises(WorkerHalted):
        process_next(db, storage, BadVerdict(db))
    assert db.get(File, file_id).failure_code == "scan_execution_unresolved"


def test_legacy_requester_requires_explicit_adoption_and_exhausted_ack_preserves_budget(
    guarded_db, actor
):
    db = guarded_db
    actor_id = actor.id
    file_id, storage = uploaded(db, actor)
    file = db.get(File, file_id)
    file.scan_requested_by = None
    db.commit()
    scanner = Scanner(db)
    assert process_next(db, storage, scanner) is False
    assert db.get(File, file_id).failure_code == "scan_adoption_required"
    service.scan(db, actor_id, file_id)
    file = db.get(File, file_id)
    file.scan_attempts = 5
    file.operation_id = uuid4()
    file.operation_expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()
    assert acknowledge_engine_replacement(db) == 1
    file = db.get(File, file_id)
    assert file.scan_attempts == 5 and file.failure_code == "scan_exhausted"
    assert file.scan_next_attempt_at is None
    service.scan(db, actor_id, file_id)
    assert db.get(File, file_id).scan_attempts == 0
    assert process_next(db, storage, scanner) is True


def test_known_storage_failure_schedules_retry_without_submitting_engine_work(guarded_db, actor):
    db = guarded_db
    file_id, storage = uploaded(db, actor)

    def unavailable(key):
        assert not db.in_transaction()
        raise ProviderUnavailable("storage offline")

    storage.download = unavailable
    scanner = Scanner(db)
    assert process_next(db, storage, scanner) is True
    assert scanner.calls == 0
    file = db.get(File, file_id)
    assert file.scan_attempts == 1 and file.failure_code == "scan_unavailable"
    assert file.operation_id is None and file.scan_next_attempt_at is not None
