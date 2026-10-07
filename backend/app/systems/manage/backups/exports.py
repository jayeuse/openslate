"""Audited encrypted-export requests and exact runner claims; callers own commit."""

import hashlib
import hmac
from datetime import datetime, timedelta
from typing import cast
from uuid import UUID

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.core.config import get_settings
from app.systems.manage.backups import service
from app.systems.manage.backups.models import BackupExportOperation, BackupRun
from app.systems.manage.backups.schemas import (
    BackupExportCreate,
    BackupExportResponse,
    ExportClaimFirst,
    ExportClaimNone,
    ExportClaimReplay,
    ExportClaimReply,
    ExportClaimResponse,
    ExportCleanedCommand,
    ExportInspectCommand,
    ExportInspectResponse,
    ExportOutcomeCommand,
)


def _source(db: Session, instance: str, source_id: UUID) -> BackupRun:
    row = db.scalar(select(BackupRun).where(BackupRun.id == source_id).with_for_update(read=True))
    if row is None or row.installation_id != instance or row.expired_at is not None:
        raise service.BackupStateError("export_source_unavailable")
    if (
        row.verified_at is None
        or row.reconciled_at is None
        or row.snapshot_id is None
        or row.manifest_sha256 is None
        or row.claim_id is None
    ):
        raise service.BackupStateError("export_source_unproven")
    return row


def queue_export(
    db: Session, instance: str, actor_id: UUID, payload: BackupExportCreate, idempotency_key: str
) -> BackupExportOperation:
    service.lock_policy(db, instance)
    key = get_settings().supabase_session_encryption_key.get_secret_value().encode("ascii")
    plaintext = payload.passphrase.get_secret_value().encode("utf-8")
    digest = hashlib.sha256(idempotency_key.encode("ascii")).hexdigest()
    payload_hmac = hmac.new(
        key,
        b"openslate.backup.export.request.v1\0" + payload.backup_run_id.bytes + b"\0" + plaintext,
        hashlib.sha256,
    ).hexdigest()
    prior = db.scalar(
        select(BackupExportOperation).where(
            BackupExportOperation.installation_id == instance,
            BackupExportOperation.requester_id == actor_id,
            BackupExportOperation.idempotency_hash == digest,
        )
    )
    if prior is not None:
        if not hmac.compare_digest(prior.payload_hmac, payload_hmac):
            raise service.BackupStateError("export_idempotency_conflict")
        return prior
    _source(db, instance, payload.backup_run_id)
    row = BackupExportOperation(
        installation_id=instance,
        backup_run_id=payload.backup_run_id,
        requester_id=actor_id,
        idempotency_hash=digest,
        payload_hmac=payload_hmac,
        requested_at=cast(datetime, db.scalar(select(func.clock_timestamp()))),
        encrypted_passphrase=Fernet(key).encrypt(plaintext).decode("ascii"),
        performed_by=actor_id,
    )
    db.add(row)
    db.flush()
    return row


def export_response(row: BackupExportOperation, instance: str) -> BackupExportResponse:
    if row.installation_id != instance:
        raise service.BackupStateError("export_identity_conflict")
    values = {field: getattr(row, field) for field in BackupExportResponse.model_fields}
    if row.state == "ready" and row.expires_at is not None and row.expires_at <= utc_now():
        values["state"] = "expired"
    return BackupExportResponse.model_validate(values)


def export_claim_response(
    db: Session, row: BackupExportOperation, instance: str
) -> ExportClaimResponse:
    source = db.get(BackupRun, row.backup_run_id)
    if source is None:
        raise service.BackupStateError("export_identity_conflict")
    return ExportClaimResponse.model_validate(
        {
            "export": export_response(row, instance),
            "claim_id": row.claim_id,
            "installation_id": row.installation_id,
            "claimed_at": row.claimed_at,
            "finished_at": row.finished_at,
            "artifact_deleted_at": row.artifact_deleted_at,
            "source": service.claim_response(source, instance),
        }
    )


def exact_export_claim(
    db: Session, instance: str, claim_id: UUID, export_id: UUID | None = None, *, lock: bool = False
) -> BackupExportOperation | None:
    statement = select(BackupExportOperation).where(BackupExportOperation.claim_id == claim_id)
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    row = db.scalar(statement)
    if row is not None and (
        row.installation_id != instance or (export_id is not None and row.id != export_id)
    ):
        raise service.BackupStateError("export_identity_conflict")
    return row


def unresolved_export(db: Session, instance: str) -> BackupExportOperation | None:
    return db.scalar(
        select(BackupExportOperation).where(
            BackupExportOperation.installation_id == instance,
            BackupExportOperation.state == "preparing",
        )
    )


def claim_export(db: Session, instance: str, claim_id: UUID) -> ExportClaimReply:
    policy = service.lock_policy(db, instance)
    prior = exact_export_claim(db, instance, claim_id)
    if prior is not None:
        return ExportClaimReplay(status="replay", claim=export_claim_response(db, prior, instance))
    if (
        service.unresolved_run(db, instance) is not None
        or unresolved_export(db, instance) is not None
    ):
        raise service.BackupStateError("backup_recovery_required")
    if policy.installation_id != instance:
        raise service.BackupStateError("backup_adoption_required")
    row = db.scalar(
        select(BackupExportOperation)
        .where(
            BackupExportOperation.installation_id == instance,
            BackupExportOperation.state == "queued",
        )
        .order_by(BackupExportOperation.requested_at, BackupExportOperation.id)
        .with_for_update(skip_locked=True)
        .limit(1)
    )
    if row is None:
        return ExportClaimNone(status="none", claim=None)
    failure = None
    try:
        _source(db, instance, row.backup_run_id)
    except service.BackupStateError as error:
        failure = (
            "source_unproven" if str(error) == "export_source_unproven" else "source_unavailable"
        )
    plaintext = None
    if failure is None:
        key = get_settings().supabase_session_encryption_key.get_secret_value().encode("ascii")
        try:
            plaintext = (
                Fernet(key)
                .decrypt((row.encrypted_passphrase or "").encode("ascii"))
                .decode("utf-8")
            )
        except (InvalidToken, UnicodeError) as error:
            raise service.BackupStateError("export_unavailable") from error
    row.claim_id, row.claimed_at = (
        claim_id,
        cast(datetime, db.scalar(select(func.clock_timestamp()))),
    )
    row.encrypted_passphrase = None
    row.state = "preparing" if failure is None else "failed"
    if failure is not None:
        row.finished_at, row.failure_code = row.claimed_at, failure
    db.flush()
    claim = export_claim_response(db, row, instance)
    if plaintext is None:
        return ExportClaimReplay(status="replay", claim=claim)
    return ExportClaimFirst(status="first", claim=claim, passphrase=plaintext)


def inspect_exports(
    db: Session, instance: str, command: ExportInspectCommand
) -> ExportInspectResponse:
    if command.installation_id != instance:
        raise service.BackupStateError("export_identity_conflict")
    exact = (
        exact_export_claim(db, instance, command.claim_id, command.export_id)
        if command.claim_id
        else None
    )
    if command.claim_id is not None and exact is None:
        raise service.BackupStateError("export_identity_conflict")
    active = unresolved_export(db, instance)
    cleanup = db.scalars(
        select(BackupExportOperation)
        .where(
            BackupExportOperation.installation_id == instance,
            BackupExportOperation.state == "ready",
            BackupExportOperation.artifact_deleted_at.is_(None),
            BackupExportOperation.expires_at <= func.clock_timestamp(),
        )
        .order_by(BackupExportOperation.expires_at, BackupExportOperation.id)
        .limit(16)
    ).all()
    return ExportInspectResponse(
        unresolved=export_claim_response(db, active, instance) if active else None,
        claim=export_claim_response(db, exact, instance) if exact else None,
        cleanup_candidates=[export_claim_response(db, row, instance) for row in cleanup],
    )


def record_export_outcome(
    db: Session, instance: str, command: ExportOutcomeCommand
) -> BackupExportOperation:
    row = exact_export_claim(db, instance, command.claim_id, command.export_id, lock=True)
    if row is None or command.installation_id != instance:
        raise service.BackupStateError("export_identity_conflict")
    fields = ("state", "finished_at", "size_bytes", "sha256", "failure_code")
    if row.state != "preparing":
        if any(getattr(row, field) != getattr(command, field) for field in fields):
            raise service.BackupStateError("export_outcome_conflict")
        return row
    if row.claimed_at is None or command.finished_at < row.claimed_at:
        raise service.BackupStateError("export_outcome_conflict")
    for field in fields:
        setattr(row, field, getattr(command, field))
    if command.state == "ready":
        row.ready_at = cast(datetime, db.scalar(select(func.clock_timestamp())))
        row.expires_at = row.ready_at + timedelta(hours=24)
    db.flush()
    return row


def record_export_cleaned(
    db: Session, instance: str, command: ExportCleanedCommand
) -> BackupExportOperation:
    row = exact_export_claim(db, instance, command.claim_id, command.export_id, lock=True)
    if row is None or command.installation_id != instance:
        raise service.BackupStateError("export_identity_conflict")
    now = cast(datetime, db.scalar(select(func.clock_timestamp())))
    if (
        row.state != "ready"
        or row.expires_at is None
        or now < row.expires_at
        or command.deleted_at < row.expires_at
    ):
        raise service.BackupStateError("export_cleanup_conflict")
    if row.artifact_deleted_at is not None:
        if row.artifact_deleted_at != command.deleted_at:
            raise service.BackupStateError("export_cleanup_conflict")
        return row
    row.artifact_deleted_at = command.deleted_at
    row.admission_digest = row.admission_actor_id = row.admission_session_id = (
        row.admission_expires_at
    ) = None
    db.flush()
    return row
