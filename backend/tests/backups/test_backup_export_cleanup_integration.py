"""Post-implementation committed-PG acceptance for bounded, fenced export cleanup."""

from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.database.session import AuditSession
from app.systems.manage.backups import exports, service
from app.systems.manage.backups.models import BackupExportOperation
from app.systems.manage.backups.schemas import ExportCleanedCommand, ExportInspectCommand

pytestmark = pytest.mark.integration


def test_cleanup_inventory_is_bounded_current_expired_and_ack_is_atomic_exact_replay(export_world):
    world = export_world
    expired = []
    with Session(world.auth.owner) as db:
        now = db.scalar(select(func.clock_timestamp()))
        for index in range(23):
            operation_id, claim_id = uuid4(), uuid4()
            world.ids.append(operation_id)
            ready = now - timedelta(days=2) + timedelta(minutes=index)
            if index == 20:
                ready = now
            row = BackupExportOperation(
                id=operation_id,
                installation_id=world.instance if index != 21 else "other-owned-instance",
                backup_run_id=world.source_id,
                requester_id=world.auth.actor_id,
                idempotency_hash=operation_id.hex * 2,
                payload_hmac="c" * 64,
                state="ready",
                claim_id=claim_id,
                encrypted_passphrase=None,
                requested_at=ready - timedelta(minutes=3),
                claimed_at=ready - timedelta(minutes=2),
                finished_at=ready - timedelta(minutes=1),
                ready_at=ready,
                expires_at=ready + timedelta(hours=24),
                size_bytes=123,
                sha256="d" * 64,
            )
            if index < 20:
                expired.append((operation_id, claim_id))
                row.admission_digest = "e" * 64
                row.admission_actor_id = world.auth.actor_id
                row.admission_session_id = world.auth.session_ids[0]
                row.admission_expires_at = row.expires_at - timedelta(minutes=1)
            elif index == 22:
                row.artifact_deleted_at = now
            db.add(row)
        db.commit()
    command = ExportInspectCommand(
        op="inspect-export", installation_id=world.instance, project="owned-export-test"
    )
    with AuditSession(world.runtime) as db:
        listed = exports.inspect_exports(db, world.instance, command)
        assert listed.unresolved is None and listed.claim is None
        assert [item.export.id for item in listed.cleanup_candidates] == [
            item[0] for item in expired[:16]
        ]
        assert "passphrase" not in listed.model_dump_json()
        operation_id, claim_id = expired[0]
        acknowledgement = ExportCleanedCommand(
            op="export-cleaned",
            installation_id=world.instance,
            project="owned-export-test",
            export_id=operation_id,
            claim_id=claim_id,
            deleted_at=now,
        )
        row = exports.record_export_cleaned(db, world.instance, acknowledgement)
        with Session(world.auth.owner) as observer:
            committed = observer.get(BackupExportOperation, operation_id)
            assert committed.artifact_deleted_at is None and committed.admission_digest is not None
        db.rollback()
        row = exports.record_export_cleaned(db, world.instance, acknowledgement)
        immutable = (row.backup_run_id, row.ready_at, row.expires_at, row.size_bytes, row.sha256)
        db.commit()
        assert row.artifact_deleted_at == now
        assert (
            row.admission_digest,
            row.admission_actor_id,
            row.admission_session_id,
            row.admission_expires_at,
        ) == (None, None, None, None)
        assert exports.record_export_cleaned(db, world.instance, acknowledgement).id == operation_id
        db.commit()
        conflict = acknowledgement.model_copy(update={"deleted_at": now + timedelta(seconds=1)})
        with pytest.raises(service.BackupStateError, match="export_cleanup_conflict"):
            exports.record_export_cleaned(db, world.instance, conflict)
        db.rollback()
        row = db.get(BackupExportOperation, operation_id)
        assert immutable == (
            row.backup_run_id,
            row.ready_at,
            row.expires_at,
            row.size_bytes,
            row.sha256,
        )
        remaining = exports.inspect_exports(db, world.instance, command)
        assert [item.export.id for item in remaining.cleanup_candidates] == [
            item[0] for item in expired[1:17]
        ]
    response = world.auth.client.get(
        f"/api/backups/exports/{operation_id}", headers=world.auth.headers()
    )
    assert response.status_code == 200 and response.json()["state"] == "expired"
    assert response.headers["cache-control"] == "no-store"
    with AuditSession(world.runtime) as db:
        for index, changes in (
            (20, {}),
            (0, {"claim_id": uuid4()}),
            (0, {"installation_id": "other-owned-instance"}),
            (21, {}),
        ):
            row = db.get(BackupExportOperation, world.ids[index])
            attempt = ExportCleanedCommand(
                op="export-cleaned",
                installation_id=world.instance,
                project="owned-export-test",
                export_id=row.id,
                claim_id=row.claim_id,
                deleted_at=now,
            )
            attempt = attempt.model_copy(update=changes)
            with pytest.raises(
                service.BackupStateError, match="export_(cleanup|identity)_conflict"
            ):
                exports.record_export_cleaned(db, world.instance, attempt)
            db.rollback()
