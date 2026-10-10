"""Committed immutable-key deletion with guarded manual purge admission."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies import require_fresh_exact_admin
from app.core.config import get_settings
from app.systems.platform.files.access import error, load, require_avatar_unbound, require_unlinked
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import ProviderUnavailable, StorageBackend
from app.systems.platform.files.quota import lock_quota
from app.systems.platform.files.schemas import FileResponse
from app.systems.platform.files.service import _claim, _current
from app.systems.sandbox.lifecycle.purge_support import PURGE_DISABLED_MESSAGE


@dataclass(frozen=True)
class DeletionClaim:
    file_id: UUID
    key: str
    token: UUID
    actor_id: UUID


def claim_logo_replacement(db: Session, file: File, actor_id: UUID) -> DeletionClaim:
    """Caller holds workspace/file locks; commit this intent with the new binding."""
    if not file.is_deleted or file.deleted_at is None:
        file.deleted_at = datetime.now(UTC)
    file.is_deleted = True
    file.deletion_origin = "logo_replacement"
    file.performed_by = actor_id
    token = _claim(db, file, "deleting")
    return DeletionClaim(file.id, file.object_key, token, actor_id)


def claim_avatar_replacement(db: Session, file: File, actor_id: UUID) -> DeletionClaim:
    """Caller holds the owner User/File locks; commit with the new self binding."""
    if file.purpose != "user_avatar" or file.creator_id != actor_id:
        raise error("file_not_found", "Avatar not found", 404)
    file.is_deleted = True
    file.deleted_at = datetime.now(UTC)
    file.deletion_origin = "avatar_replacement"
    file.performed_by = actor_id
    token = _claim(db, file, "deleting")
    return DeletionClaim(file.id, file.object_key, token, actor_id)


def delete_and_finalize(db: Session, claim: DeletionClaim, storage: StorageBackend) -> FileResponse:
    """Perform only committed immutable-key intent, then commit token-fenced finalization.

    Completing this admitted effect must not depend on the actor retaining their role.
    """
    try:
        storage.delete(claim.key)
        if storage.download(claim.key) is not None:
            raise ProviderUnavailable("Object deletion is not confirmed")
    except ProviderUnavailable as exc:
        try:
            file = _current(db, claim.file_id, claim.token, "deleting")
            file.failure_code = "deletion_unresolved"
            file.operation_expires_at = datetime.now(UTC)
            db.commit()
        except SQLAlchemyError:
            db.rollback()
        raise error("deletion_unresolved", "Deletion requires reconciliation", 503) from exc
    try:
        file = _current(db, claim.file_id, claim.token, "deleting")
        file.state = "purged"
        file.operation_id = None
        file.operation_expires_at = None
        file.deletion_origin = None
        file.failure_code = None
        db.commit()
        return FileResponse.model_validate(file)
    except SQLAlchemyError as exc:
        db.rollback()
        raise error("deletion_unresolved", "Deletion requires reconciliation", 503) from exc


def purge_confirmed(
    db: Session,
    actor_id: UUID,
    file_id: UUID,
    storage: StorageBackend,
    *,
    validate_locked: Callable[[], None] | None = None,
    board_id: UUID | None = None,
) -> FileResponse:
    """Parent must validate its signed/digest confirmation and current-logo exclusion."""
    if not get_settings().lifecycle_purge_enabled:
        raise error("purge_disabled", PURGE_DISABLED_MESSAGE, 403)
    lock_quota(db)
    require_fresh_exact_admin(db, actor_id)
    if validate_locked is not None:
        validate_locked()
    file = load(db, file_id, lock=True)
    require_avatar_unbound(db, file)
    if file.purpose == "board_attachment":
        if board_id is None or file.board_id != board_id:
            raise error("file_not_found", "File not found", 404)
        require_unlinked(db, file.id)
    elif board_id is not None:
        raise error("file_not_found", "File not found", 404)
    if file.state == "purged":
        return FileResponse.model_validate(file)
    if not file.is_deleted:
        raise error("close_required", "Archive the file before purging")
    if file.state == "uploading":
        raise error("upload_unresolved", "An unresolved upload blocks permanent purge")
    if file.operation_id is not None and file.state != "deleting":
        # An active operation must finish or be fenced by reconciliation first.
        raise error("file_operation_active", "Reconcile the file operation before purging")
    if (
        file.state == "deleting"
        and file.operation_expires_at is not None
        and file.operation_expires_at > datetime.now(UTC)
    ):
        raise error("file_operation_active", "Deletion is still active")
    token = _claim(db, file, "deleting")
    claim = DeletionClaim(file.id, file.object_key, token, actor_id)
    db.commit()
    return delete_and_finalize(db, claim, storage)
