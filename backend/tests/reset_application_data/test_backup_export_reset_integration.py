"""Guarded committed reset/export preservation, with fake provider boundaries only."""

import os
from datetime import timedelta
from unittest.mock import Mock
from uuid import uuid4

import pytest
from psycopg import connect
from sqlalchemy import create_engine, func, inspect, select
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentityMfaObservation, IdentitySession
from app.systems.access.users.models import User
from app.systems.manage.backups.models import BackupRun
from app.systems.manage.workspace.models import WorkspaceProfile
from operations import reset_application_data as reset
from operations.reset import execution
from operations.reset.backups import read_backup_snapshot, validate_backup_preservation
from tests.conftest import _guard_integration_database
from tests.reset_application_data.execution_support import apply_confirmed

pytestmark = pytest.mark.integration


@pytest.fixture
def export_reset(request, monkeypatch, tmp_path):
    monkeypatch.setenv("OPENSLATE_ENV_SOURCE", "process")
    owner_url = os.environ["MIGRATION_DATABASE_URL"]
    _guard_integration_database(owner_url)
    engine = create_engine(owner_url)
    admin_id, member_id, provider_id = uuid4(), uuid4(), uuid4()
    source_id = uuid4()
    with Session(engine) as db:
        profile = db.scalar(select(WorkspaceProfile))
        saved_profile = {
            column.key: getattr(profile, column.key)
            for column in inspect(WorkspaceProfile).column_attrs
        }
        now = db.scalar(select(func.clock_timestamp()))
        instance = db.scalar(select(func.current_setting("cluster_name")))
        db.add_all(
            [
                User(
                    id=admin_id,
                    email=f"export-reset-{admin_id}@example.test",
                    username=f"er-{admin_id.hex}",
                    role="admin",
                    status="active",
                    supabase_user_id=provider_id,
                ),
                User(
                    id=member_id,
                    email=f"export-reset-{member_id}@example.test",
                    username=f"er-{member_id.hex}",
                    role="member",
                    status="active",
                ),
            ]
        )
        db.flush()
        db.add(
            BackupRun(
                id=source_id,
                installation_id=instance,
                name="Owned reset export source",
                provenance="manual",
                requester_id=member_id,
                idempotency_hash=source_id.hex * 2,
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
    from app.systems.manage.backups.models import BackupExportOperation

    ids = [uuid4() for _ in range(5)]
    with Session(engine) as db:
        for index, operation_id in enumerate(ids):
            row = BackupExportOperation(
                id=operation_id,
                installation_id=instance if index != 4 else "previous-installation",
                backup_run_id=source_id,
                requester_id=member_id if index != 2 else admin_id,
                performed_by=member_id,
                idempotency_hash=operation_id.hex * 2,
                payload_hmac="c" * 64,
                requested_at=now - timedelta(minutes=30),
                encrypted_passphrase="owned-encrypted-request",
            )
            if index in (1, 2, 3):
                row.state, row.claim_id, row.claimed_at, row.encrypted_passphrase = (
                    "ready",
                    uuid4(),
                    now - timedelta(minutes=29),
                    None,
                )
                row.finished_at = now - timedelta(minutes=28)
                row.ready_at, row.expires_at = (
                    now - timedelta(minutes=27),
                    now + timedelta(hours=24, minutes=-27),
                )
                row.size_bytes, row.sha256 = 123, "d" * 64
                row.admission_digest, row.admission_actor_id, row.admission_session_id = (
                    "e" * 64,
                    member_id,
                    uuid4(),
                )
                row.admission_expires_at = now + timedelta(minutes=5)
            if index == 3:
                row.state, row.failure_code = "failed", "copy_failed"
                row.ready_at = row.expires_at = row.size_bytes = row.sha256 = None
                row.admission_digest = row.admission_actor_id = row.admission_session_id = (
                    row.admission_expires_at
                ) = None
            db.add(row)
        db.commit()
    artifact = tmp_path / f"{ids[1]}.tar"
    artifact.write_bytes(b"Owned untouched host artifact")
    database = connect(owner_url.replace("postgresql+psycopg://", "postgresql://", 1))
    storage, auth = Mock(), Mock()
    storage.list_object_keys.return_value = ()
    world = type(
        "ExportReset",
        (),
        {
            "database": database,
            "engine": engine,
            "admin_id": admin_id,
            "member_id": member_id,
            "provider_id": provider_id,
            "ids": ids,
            "source_id": source_id,
            "instance": instance,
            "artifact": artifact,
            "storage": storage,
            "auth": auth,
            "email": f"export-reset-{admin_id}@example.test",
        },
    )()
    try:
        yield world
    finally:
        database.rollback()
        database.close()
        with Session(engine) as db:
            for row in db.scalars(
                select(BackupExportOperation).where(BackupExportOperation.id.in_(ids))
            ):
                db.delete(row)
            db.flush()
            source = db.get(BackupRun, source_id)
            if source is not None:
                db.delete(source)
            profile = db.scalar(select(WorkspaceProfile))
            for name, value in saved_profile.items():
                setattr(profile, name, value)
            for user in db.scalars(select(User).where(User.id.in_([admin_id, member_id]))):
                db.delete(user)
            db.commit()
        engine.dispose()


def test_reset_retains_export_history_and_artifact_but_clears_admission_and_current_queue(
    export_reset,
):
    world = export_reset
    plan = reset.build_reset_plan(world.database, world.email, storage_object_keys=())
    assert plan.counts["backup_export_operations"] >= 5
    before = read_backup_snapshot(world.database)
    world.auth.list_account_ids.side_effect = (plan.provider_account_ids, ())
    apply_confirmed(
        world.database,
        plan,
        storage=world.storage,
        auth=world.auth,
    )
    validate_backup_preservation(world.database, before, world.admin_id)
    from app.systems.manage.backups.models import BackupExportOperation

    with Session(world.engine) as db:
        assert db.get(BackupExportOperation, world.ids[0]) is None
        for operation_id in world.ids[1:]:
            row = db.get(BackupExportOperation, operation_id)
            assert row is not None
            assert (
                row.admission_digest
                is row.admission_actor_id
                is row.admission_session_id
                is row.admission_expires_at
                is None
            )
            assert row.requester_id == (world.admin_id if operation_id == world.ids[2] else None)
        assert db.get(BackupRun, world.source_id) is not None
        assert db.scalar(select(func.count()).select_from(IdentitySession)) == 0
        assert db.scalar(select(func.count()).select_from(IdentityMfaObservation)) == 0
    assert world.artifact.read_bytes() == b"Owned untouched host artifact"


def test_preparing_export_after_preview_blocks_before_any_provider_effect(export_reset):
    world = export_reset
    plan = reset.build_reset_plan(world.database, world.email, storage_object_keys=())
    world.auth.list_account_ids.side_effect = (plan.provider_account_ids, ())
    from app.systems.manage.backups.models import BackupExportOperation

    with Session(world.engine) as db:
        row = db.get(BackupExportOperation, world.ids[0])
        row.state, row.claim_id, row.claimed_at, row.encrypted_passphrase = (
            "preparing",
            uuid4(),
            db.scalar(select(func.clock_timestamp())),
            None,
        )
        db.commit()
    with pytest.raises(reset.ResetError, match="export"):
        apply_confirmed(
            world.database,
            plan,
            storage=world.storage,
            auth=world.auth,
        )
    world.auth.delete_and_verify_missing.assert_not_called()
    assert world.artifact.exists()
    with pytest.raises(reset.ResetError, match="export"):
        reset.build_reset_plan(world.database, world.email)


@pytest.mark.parametrize("failure", ["provider", "sql", "retained-source-queue"])
def test_reset_failure_retains_export_state_and_refuses_restricted_source_before_effect(
    export_reset, monkeypatch, failure
):
    world = export_reset
    if failure == "retained-source-queue":
        with Session(world.engine) as db:
            source = db.get(BackupRun, world.source_id)
            source.state = "queued"
            for field in (
                "claim_id",
                "claimed_schedule",
                "claimed_retention_days",
                "started_at",
                "finished_at",
                "reconciled_at",
                "verified_at",
                "snapshot_id",
                "manifest_sha256",
            ):
                setattr(source, field, None)
            db.commit()
        with pytest.raises(reset.ResetError, match="export"):
            reset.build_reset_plan(world.database, world.email)
        world.auth.delete_and_verify_missing.assert_not_called()
        return
    plan = reset.build_reset_plan(world.database, world.email, storage_object_keys=())
    snapshot = read_backup_snapshot(world.database)
    world.auth.list_account_ids.side_effect = (plan.provider_account_ids, ())
    if failure == "provider":
        world.auth.delete_and_verify_missing.side_effect = RuntimeError("Owned provider boundary")
    else:
        original = execution._reset_sandbox_workspace

        def fail(connection):
            original(connection)
            raise RuntimeError("Owned pre-commit reset fault")

        monkeypatch.setattr(execution, "_reset_sandbox_workspace", fail)
    with pytest.raises(reset.ResetError):
        apply_confirmed(
            world.database,
            plan,
            storage=world.storage,
            auth=world.auth,
        )
    assert read_backup_snapshot(world.database) == snapshot
    assert world.artifact.read_bytes() == b"Owned untouched host artifact"
