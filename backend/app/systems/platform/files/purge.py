"""File purge execution, called only after lifecycle confirmation is verified."""

from collections.abc import Callable
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.orm import Session

from app.common.dependencies import require_fresh_exact_admin
from app.core.config import get_settings
from app.systems.platform.files.access import error, load
from app.systems.platform.files.providers import ProviderUnavailable, Storage
from app.systems.platform.files.quota import lock_quota
from app.systems.platform.files.scan_queue import UNRESOLVED
from app.systems.platform.files.schemas import FileResponse
from app.systems.platform.files.service import _claim, _current


def purge_confirmed(
    db: Session,
    actor_id: UUID,
    file_id: UUID,
    storage: Storage,
    *,
    validate_locked: Callable[[], None] | None = None,
) -> FileResponse:
    """Parent must validate its signed/digest confirmation and current-logo exclusion."""
    if not get_settings().lifecycle_purge_enabled:
        raise error("purge_disabled", "Permanent purge is disabled", 403)
    lock_quota(db)
    require_fresh_exact_admin(db, actor_id)
    if validate_locked is not None:
        validate_locked()
    file = load(db, file_id, lock=True)
    if file.failure_code == UNRESOLVED:
        raise error(UNRESOLVED, "Scanner execution requires operator recovery")
    if file.state == "purged":
        return FileResponse.model_validate(file)
    if not file.is_deleted:
        raise error("close_required", "Archive the file before purging")
    if file.state == "uploading":
        raise error("upload_unresolved", "An unresolved upload blocks permanent purge")
    if file.operation_id is not None and file.state != "deleting":
        # An active scan must finish or have its token explicitly fenced by reconciliation.
        raise error("file_operation_active", "Reconcile the file operation before purging")
    if (
        file.state == "deleting"
        and file.operation_expires_at is not None
        and file.operation_expires_at > datetime.now(UTC)
    ):
        raise error("file_operation_active", "Deletion is still active")
    token = _claim(db, file, "deleting")
    key = file.object_key
    db.commit()
    try:
        storage.delete(key)
        if storage.download(key) is not None:
            raise ProviderUnavailable("Object deletion is not confirmed")
    except ProviderUnavailable as exc:
        file = _current(db, file_id, token, "deleting")
        file.failure_code = "deletion_unresolved"
        # Retry is safe: admitted upload was settled and keys never get reused.
        file.operation_expires_at = datetime.now(UTC)
        db.commit()
        raise error("deletion_unresolved", "Deletion requires reconciliation", 503) from exc
    file = _current(db, file_id, token, "deleting")
    file.state = "purged"
    file.operation_id = None
    file.operation_expires_at = None
    file.failure_code = None
    db.commit()
    return FileResponse.model_validate(file)
