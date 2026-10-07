"""Signed HTTP and committed PostgreSQL export boundaries, never host backup work."""

from datetime import timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from sqlalchemy import event, func, inspect, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.database.session import AuditSession, get_engine
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User
from app.systems.manage.audit.models import AuditLog, SecurityEvent
from app.systems.manage.backups.models import BackupRun

pytest_plugins = ("tests.auth.session_policy_support",)
pytestmark = pytest.mark.integration
SECRET = "Example export 🌿 passphrase"
PUBLIC_FIELDS = {
    "id",
    "backup_run_id",
    "state",
    "requested_at",
    "ready_at",
    "expires_at",
    "size_bytes",
    "sha256",
    "failure_code",
}


@pytest.fixture
def export_world(policy_world):
    world = policy_world
    with Session(world.owner) as db:
        instance = db.scalar(select(func.current_setting("cluster_name")))
        now = db.scalar(select(func.clock_timestamp()))
        source_id = uuid4()
        db.add(
            BackupRun(
                id=source_id,
                installation_id=instance,
                name="Owned export source",
                provenance="manual",
                requester_id=world.actor_id,
                idempotency_hash=uuid4().hex * 2,
                schedule="disabled",
                retention_days=30,
                requested_at=now - timedelta(hours=3),
                state="succeeded",
                claim_id=uuid4(),
                claimed_schedule="disabled",
                claimed_retention_days=30,
                started_at=now - timedelta(hours=2),
                finished_at=now - timedelta(hours=1),
                reconciled_at=now - timedelta(minutes=59),
                verified_at=now - timedelta(minutes=61),
                snapshot_id="a" * 64,
                manifest_sha256="b" * 64,
            )
        )
        db.commit()
    ids = []
    source_ids = [source_id]

    def create(key=None, **body):
        response = world.client.post(
            "/api/backups/exports",
            headers={**world.headers(), "Idempotency-Key": key or uuid4().hex},
            json={"backup_run_id": str(source_id), "passphrase": SECRET, **body},
        )
        if response.status_code == 201:
            ids.append(UUID(response.json()["id"]))
        return response

    yield SimpleNamespace(
        auth=world,
        source_id=source_id,
        instance=instance,
        runtime=get_engine(),
        create=create,
        ids=ids,
        source_ids=source_ids,
    )
    with Session(world.owner) as db:
        if ids:
            from app.systems.manage.backups.models import BackupExportOperation

            for event in db.scalars(select(SecurityEvent).where(SecurityEvent.subject_id.in_(ids))):
                db.delete(event)
            for audit in db.scalars(
                select(AuditLog).where(AuditLog.entity_id.in_(ids + source_ids))
            ):
                db.delete(audit)
            for row in db.scalars(
                select(BackupExportOperation).where(
                    BackupExportOperation.backup_run_id == source_id
                )
            ):
                db.delete(row)
            db.flush()
        for source in db.scalars(select(BackupRun).where(BackupRun.id.in_(source_ids))):
            db.delete(source)
        db.commit()


@pytest.mark.parametrize("retention_failed", [False, True])
def test_current_verified_source_queues_safe_export_and_replays_exact_request(
    export_world, retention_failed
):
    world = export_world
    if retention_failed:
        with Session(world.auth.owner) as db:
            source = db.get(BackupRun, world.source_id)
            source.state, source.failure_code = "failed", "retention_failed"
            db.commit()
    assert (
        world.auth.client.get("/api/backups/status", headers=world.auth.headers()).status_code
        == 200
    )
    key = uuid4().hex
    first = world.create(key)
    assert first.status_code == 201
    data = first.json()
    assert set(data) == PUBLIC_FIELDS and data["state"] == "queued"
    assert data["backup_run_id"] == str(world.source_id)
    assert all(
        data[k] is None for k in ("ready_at", "expires_at", "size_bytes", "sha256", "failure_code")
    )
    assert first.headers["cache-control"] == "no-store"
    assert first.headers["location"] == f"/api/backups/exports/{data['id']}"
    assert SECRET not in first.text
    replay = world.create(key)
    assert replay.status_code == 201 and replay.json() == data
    assert world.create(key, passphrase=SECRET + " changed").status_code == 409
    loaded = world.auth.client.get(first.headers["location"], headers=world.auth.headers())
    assert loaded.status_code == 200 and loaded.json() == data
    assert loaded.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "changed",
    [
        {"state": "unknown"},
        {"is_deleted": True},
        {"encrypted_passphrase": None},
        {"claim_id": uuid4()},
        {"state": "preparing"},
        {"size_bytes": 0},
        {"admission_actor_id": uuid4()},
        {"artifact_deleted_at": "now"},
    ],
)
def test_export_database_rejects_incoherent_secret_claim_and_artifact_state(export_world, changed):
    world = export_world
    created = world.create()
    assert created.status_code == 201
    from app.systems.manage.backups.models import BackupExportOperation

    operation_id = UUID(created.json()["id"])
    with AuditSession(world.runtime) as db:
        row = db.get(BackupExportOperation, operation_id)
        for field, value in changed.items():
            setattr(
                row, field, db.scalar(select(func.clock_timestamp())) if value == "now" else value
            )
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()
    with Session(world.auth.owner) as db:
        assert db.get(BackupExportOperation, operation_id).state == "queued"


def test_export_runtime_privileges_source_restrict_and_secret_audit_redaction(export_world):
    world = export_world
    created = world.create()
    assert created.status_code == 201
    from app.systems.manage.backups.models import BackupExportOperation

    with AuditSession(world.runtime) as db:
        allowed = db.scalar(
            select(
                func.has_table_privilege(
                    func.current_user(),
                    "public.backup_export_operations",
                    "SELECT,INSERT,UPDATE,DELETE",
                )
            )
        )
        assert allowed is True
        row = db.get(BackupExportOperation, UUID(created.json()["id"]))
        secret_values = [
            getattr(row, f) for f in ("encrypted_passphrase", "idempotency_hash", "payload_hmac")
        ]
        logs = list(db.scalars(select(AuditLog).where(AuditLog.entity_id == row.id)))
        assert logs
        import json

        hidden = all(value not in json.dumps(log.after) for log in logs for value in secret_values)
        assert hidden
        db.delete(db.get(BackupRun, world.source_id))
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()
    foreign_keys = inspect(world.runtime).get_foreign_keys("backup_export_operations")
    assert any(
        f["constrained_columns"] == ["backup_run_id"] and f["options"].get("ondelete") == "RESTRICT"
        for f in foreign_keys
    )
    assert any(
        f["constrained_columns"] == ["performed_by"] and f["options"].get("ondelete") == "SET NULL"
        for f in foreign_keys
    )
    assert not any(
        f["constrained_columns"] in (["admission_actor_id"], ["admission_session_id"])
        for f in foreign_keys
    )


@pytest.mark.parametrize("rollback", [False, True])
def test_claim_commit_erases_secret_and_replay_never_reissues_it(export_world, rollback):
    world = export_world
    created = world.create()
    assert created.status_code == 201
    from app.systems.manage.backups import exports
    from app.systems.manage.backups.models import BackupExportOperation

    operation_id, claim_id = UUID(created.json()["id"]), uuid4()
    with AuditSession(world.runtime) as db:
        first = exports.claim_export(db, world.instance, claim_id)
        assert first.status == "first" and first.claim.export.id == operation_id
        correct = first.passphrase.get_secret_value() == SECRET
        assert correct
        assert first.claim.source.claim_id != claim_id
        assert first.claim.source.run.id == world.source_id
        with Session(world.auth.owner) as observer:
            before = observer.get(BackupExportOperation, operation_id)
            assert before.state == "queued" and before.encrypted_passphrase is not None
        if rollback:

            def fault(_db):
                raise SQLAlchemyError("Owned pre-commit fault")

            event.listen(db, "before_commit", fault, once=True)
            with pytest.raises(SQLAlchemyError):
                db.commit()
            db.rollback()
        else:
            db.commit()
        with Session(world.auth.owner) as observer:
            after = observer.get(BackupExportOperation, operation_id)
            assert (after.state, after.encrypted_passphrase is None) == (
                ("queued", False) if rollback else ("preparing", True)
            )
        if not rollback:
            replay = exports.claim_export(db, world.instance, claim_id)
            assert replay.status == "replay" and "passphrase" not in replay.model_dump()
            db.commit()
            with pytest.raises(exports.service.BackupStateError):
                exports.claim_export(db, world.instance, uuid4())
            db.rollback()


def test_database_excludes_second_unresolved_export_even_without_service(export_world):
    world = export_world
    first, second = world.create(), world.create()
    assert first.status_code == second.status_code == 201
    from app.systems.manage.backups import exports
    from app.systems.manage.backups.models import BackupExportOperation

    with AuditSession(world.runtime) as db:
        exports.claim_export(db, world.instance, uuid4())
        db.commit()
        row = db.get(BackupExportOperation, UUID(second.json()["id"]))
        row.state, row.claim_id = "preparing", uuid4()
        row.claimed_at, row.encrypted_passphrase = db.scalar(select(func.clock_timestamp())), None
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()


def test_downgrade_refuses_export_history_without_changing_current_revision(export_world):
    world = export_world
    created = world.create()
    assert created.status_code == 201
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import text

    config = Config("alembic.ini")
    with pytest.raises(RuntimeError, match="export"):
        command.downgrade(config, "7d4538964ae2")
    with Session(world.auth.owner) as db:
        assert db.scalar(text("SELECT version_num FROM alembic_version")) == "dc22b5c205a4"
        assert (
            db.scalar(
                text("SELECT count(*) FROM backup_export_operations WHERE id=:id"),
                {"id": UUID(created.json()["id"])},
            )
            == 1
        )


@pytest.mark.parametrize(
    "reason", ["foreign", "expired", "unproven", "missing", "member", "guest", "revoked", "mfa"]
)
def test_export_source_refusal_and_invalidated_claim_never_handoff_secret(export_world, reason):
    world = export_world
    queued = world.create()
    assert queued.status_code == 201
    from app.systems.manage.backups import exports
    from app.systems.manage.backups.models import BackupExportOperation

    with Session(world.auth.owner) as db:
        source = db.get(BackupRun, world.source_id)
        if reason in {"member", "guest"}:
            db.get(User, world.auth.actor_id).role = reason
            if reason == "guest":
                db.get(User, world.auth.actor_id).sponsor_user_id = world.auth.target_id
                db.get(User, world.auth.actor_id).expires_at = world.auth.clock + timedelta(days=1)
        elif reason == "revoked":
            db.get(IdentitySession, world.auth.session_ids[0]).revoked_at = world.auth.clock
        elif reason == "foreign":
            source.installation_id = "owned-other-installation"
        elif reason == "expired":
            source.expired_at = db.scalar(select(func.clock_timestamp()))
        elif reason == "unproven":
            source.state, source.failure_code = "failed", "verification_failed"
            source.verified_at = source.snapshot_id = source.manifest_sha256 = None
        db.commit()
    if reason == "mfa":
        world.auth.factor_status = "verified"
        world.auth.policy(mfa_require_admin=True)
    refused = world.create(
        backup_run_id=str(uuid4()) if reason == "missing" else str(world.source_id)
    )
    assert refused.status_code == (
        401 if reason == "revoked" else 403 if reason in {"member", "guest", "mfa"} else 409
    )
    if reason in {"missing", "member", "guest", "revoked", "mfa"}:
        return
    with AuditSession(world.runtime) as db:
        claim_id = uuid4()
        terminal = exports.claim_export(db, world.instance, claim_id)
        assert terminal.status == "replay" and "passphrase" not in terminal.model_dump()
        assert terminal.claim.export.state == "failed"
        assert terminal.claim.export.failure_code == (
            "source_unproven" if reason == "unproven" else "source_unavailable"
        )
        db.commit()
        row = db.get(BackupExportOperation, UUID(queued.json()["id"]))
        assert row.encrypted_passphrase is None and row.finished_at == row.claimed_at
        assert (
            exports.claim_export(db, world.instance, claim_id).model_dump() == terminal.model_dump()
        )
        db.rollback()


def test_export_terminal_identity_replay_and_source_retention_preserve_ready_lifetime(export_world):
    world = export_world
    created = world.create()
    assert created.status_code == 201
    from app.systems.manage.backups import exports
    from app.systems.manage.backups.schemas import ExportOutcomeCommand

    with AuditSession(world.runtime) as db:
        first = exports.claim_export(db, world.instance, uuid4())
        db.commit()
        command = ExportOutcomeCommand(
            op="export-outcome",
            installation_id=world.instance,
            project="owned-export-test",
            export_id=first.claim.export.id,
            claim_id=first.claim.claim_id,
            state="ready",
            finished_at=db.scalar(select(func.clock_timestamp())),
            size_bytes=123,
            sha256="c" * 64,
            failure_code=None,
        )
        row = exports.record_export_outcome(db, world.instance, command)
        db.commit()
        ready_at, expires_at = row.ready_at, row.expires_at
        assert expires_at - ready_at == timedelta(hours=24)
        exports.record_export_outcome(db, world.instance, command)
        db.commit()
        assert (row.ready_at, row.expires_at) == (ready_at, expires_at)
        for changed in ({"size_bytes": 124}, {"claim_id": uuid4()}):
            with pytest.raises(exports.service.BackupStateError):
                exports.record_export_outcome(
                    db, world.instance, command.model_copy(update=changed)
                )
            db.rollback()
    with Session(world.auth.owner) as db:
        db.get(BackupRun, world.source_id).expired_at = db.scalar(select(func.clock_timestamp()))
        db.commit()
    response = world.auth.client.get(created.headers["location"], headers=world.auth.headers())
    assert response.status_code == 200 and response.json()["state"] == "ready"
    assert response.json()["expires_at"] == expires_at.isoformat().replace("+00:00", "Z")


@pytest.mark.parametrize(
    "invalid",
    [15, 129, " leading valid passphrase", "valid passphrase\n", True, None, {"nested": SECRET}],
)
def test_export_secret_validation_keeps_all_input_and_unknown_keys_private(export_world, invalid):
    world = export_world
    payload = {"backup_run_id": str(world.source_id), "passphrase": invalid}
    if invalid in (15, 129):
        payload["passphrase"] = "x" * invalid
    response = world.auth.client.post(
        "/api/backups/exports",
        headers={**world.auth.headers(), "Idempotency-Key": uuid4().hex},
        json={**payload, SECRET: SECRET},
    )
    assert response.status_code == 422
    assert SECRET not in response.text
    assert response.headers["cache-control"] == "no-store"
    assert all("input" not in item and "ctx" not in item for item in response.json()["detail"])
    assert all(
        set(item["loc"]) <= {"body", "passphrase", "backup_run_id"}
        for item in response.json()["detail"]
    )


def test_backup_and_export_new_claims_exclude_each_other_but_backup_replay_survives(export_world):
    world = export_world
    created = world.create()
    assert created.status_code == 201
    from app.systems.manage.backups import exports, service

    with AuditSession(world.runtime) as db:
        backup = service.queue_manual(
            db, world.instance, world.auth.actor_id, "Owned exclusion", uuid4().hex
        )
        world.source_ids.append(backup.id)
        db.commit()
        backup_id, backup_claim = backup.id, uuid4()
        claimed = service.claim_run(db, world.instance, backup_claim)
        assert claimed.id == backup_id
        db.commit()
        with pytest.raises(service.BackupStateError):
            exports.claim_export(db, world.instance, uuid4())
        db.rollback()
        assert service.claim_run(db, world.instance, backup_claim).id == backup_id
        db.rollback()
        row = db.get(BackupRun, backup_id)
        row.state, row.failure_code = "failed", "backup_failed"
        row.finished_at = row.reconciled_at = db.scalar(select(func.clock_timestamp()))
        db.commit()
        exports.claim_export(db, world.instance, uuid4())
        db.commit()
        with pytest.raises(service.BackupStateError):
            service.claim_run(db, world.instance, uuid4())
        db.rollback()
        db.delete(db.get(BackupRun, backup_id))
        db.commit()


@pytest.mark.parametrize("chunked", [False, True])
def test_export_secret_body_limit_works_without_trusting_declared_length(export_world, chunked):
    world = export_world
    body = (
        b'{"backup_run_id":"'
        + str(world.source_id).encode()
        + b'","passphrase":"'
        + b"x" * 2000
        + b'"}'
    )
    response = world.auth.client.post(
        "/api/backups/exports",
        headers={
            **world.auth.headers(),
            "Idempotency-Key": uuid4().hex,
            "Content-Type": "application/json",
        },
        content=(part for part in (body[:900], body[900:])) if chunked else body,
    )
    assert response.status_code == 413 and response.headers["cache-control"] == "no-store"
    assert "x" * 128 not in response.text


def test_empty_export_downgrade_upgrade_and_alembic_catalog_are_clean(integration_owner_db):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import text

    config = Config("alembic.ini")
    integration_owner_db.rollback()
    with get_engine().connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM backup_export_operations")) == 0
    command.downgrade(config, "7d4538964ae2")
    command.upgrade(config, "dc22b5c205a4")
    command.check(config)
    with get_engine().connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "dc22b5c205a4"
