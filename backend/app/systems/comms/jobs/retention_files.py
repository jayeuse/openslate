"""Policy-admitted erasure uses existing immutable-key file claims and confirmed finalization."""

from datetime import datetime
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.systems.platform.files.access import require_unlinked
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import StorageBackend, transfer_slot
from app.systems.platform.files.purge import DeletionClaim, delete_and_finalize
from app.systems.platform.files.service import _claim


def mark_file(db: Session, file: File, now: datetime) -> None:
    if file.purpose != "comms_attachment":
        raise ValueError("Retention cannot claim another file purpose")
    file.retention_erased_at = file.retention_erased_at or now
    file.is_deleted, file.deleted_at = True, file.deleted_at or now
    if file.state == "purged":
        return
    try:
        require_unlinked(db, file.id)
    except HTTPException:
        file.failure_code = "retention_pending"
        return
    if file.state == "uploading" or (file.operation_id is not None and file.state != "deleting"):
        # Fence reads immediately, but do not discard an unresolved writer's claim.
        file.failure_code = "retention_pending"
        return
    if file.state != "deleting":
        _claim(db, file, "deleting")
        file.operation_expires_at = utc_now()  # Committed intent, no provider worker claimed yet.
        file.deletion_origin = "comms_retention"


def cleanup_file(db: Session, identity: UUID, actor_id: UUID, storage: StorageBackend) -> bool:
    """Own commits around provider I/O; only confirmed metadata may be removed by the caller."""
    file = db.scalar(
        select(File)
        .where(
            File.org_id == bound_organization_column(),
            File.id == identity,
            File.purpose == "comms_attachment",
            File.retention_erased_at.is_not(None),
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if file is None:
        db.rollback()
        return True
    if file.state == "purged":
        db.commit()
        return True
    try:
        require_unlinked(db, file.id)
    except HTTPException:
        db.commit()
        return False
    if file.operation_expires_at is not None and file.operation_expires_at > utc_now():
        db.commit()
        return False
    if file.state == "uploading":
        key, digest, size, old_token = (
            file.object_key,
            file.digest,
            file.actual_size,
            file.operation_id,
        )
        db.commit()
        with transfer_slot():
            content = storage.download(key)
        from hashlib import sha256

        if (
            content is None
            or digest is None
            or size is None
            or len(content) != size
            or sha256(content).hexdigest() != digest
        ):
            return (
                False  # Unknown upload outcome is not proof of absence or permission to discard it.
            )
        file = db.scalar(
            select(File)
            .where(File.id == identity, File.org_id == bound_organization_column())
            .with_for_update()
        )
        if file is None or file.operation_id != old_token or file.retention_erased_at is None:
            db.rollback()
            return False
    elif file.operation_id is not None and file.state != "deleting":
        db.commit()
        return False
    token = _claim(db, file, "deleting")
    file.deletion_origin = "comms_retention"
    claim = DeletionClaim(file.id, file.object_key, token, actor_id)
    db.commit()
    with transfer_slot():
        delete_and_finalize(db, claim, storage)
    return True
