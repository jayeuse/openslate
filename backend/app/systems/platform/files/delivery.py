"""Private file delivery; callers establish authority before provider reads."""

from hashlib import sha256
from uuid import UUID, uuid4

from sqlalchemy.orm import Session

from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import (
    SecurityEventPersistenceError,
    append_committed_security_event,
)
from app.systems.platform.files.access import authorize, error, fresh_user, load
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import ProviderUnavailable, StorageBackend


def read_content(db: Session, file: File, storage: StorageBackend) -> tuple[bytes, str, str]:
    """Caller authorizes and locks ready inventory; release its transaction before I/O."""
    if file.state != "ready":
        raise error("file_not_ready", "File is not available")
    key, digest, size = file.object_key, file.digest, file.actual_size
    filename, media_type = file.filename, file.media_type or "application/octet-stream"
    db.commit()
    try:
        content = storage.download(key)
    except ProviderUnavailable as exc:
        raise error("storage_unavailable", "File content is unavailable", 503) from exc
    if content is None or sha256(content).hexdigest() != digest or len(content) != size:
        raise error("file_integrity_error", "File content is unavailable", 503)
    return content, media_type, filename


def record_download(actor_id: UUID, file_id: UUID) -> None:
    try:
        append_committed_security_event(
            SecurityEventIngestRequest(
                event_type="file.download",
                outcome=SecurityEventOutcome.ATTEMPT,
                source="files",
                operation_id=uuid4(),
                actor_id=actor_id,
                metadata={"file_id": str(file_id)},
            )
        )
    except SecurityEventPersistenceError as exc:
        raise error("file_event_unavailable", "Unable to record file access", 503) from exc


def download(
    db: Session,
    actor_id: UUID,
    file_id: UUID,
    storage: StorageBackend,
    *,
    current_logo: bool = False,
) -> tuple[bytes, str, str]:
    candidate = load(db, file_id)
    user = fresh_user(db, actor_id)
    if current_logo:
        # Caller must check the profile reference under its lock first.
        if candidate.purpose != "workspace_logo" or candidate.is_deleted:
            raise error("file_not_found", "Logo not found", 404)
    else:
        authorize(
            db,
            user,
            candidate.purpose,
            record_id=candidate.record_id,
            department_id=candidate.department_id,
            creator_id=candidate.creator_id,
        )
    file = load(db, file_id, lock=True, shared_lock=True)
    content, media_type, filename = read_content(db, file, storage)
    # Recheck after provider latency, including a concurrent deletion/admission change.
    candidate = load(db, file_id)
    fresh_actor = fresh_user(db, actor_id)
    if not current_logo:
        authorize(
            db,
            fresh_actor,
            candidate.purpose,
            record_id=candidate.record_id,
            department_id=candidate.department_id,
            creator_id=candidate.creator_id,
        )
    file = load(db, file_id, lock=True, shared_lock=True)
    if current_logo and file.is_deleted:
        raise error("file_not_found", "Logo not found", 404)
    if file.state != "ready":
        raise error("file_not_ready", "File is not available")
    db.commit()
    record_download(actor_id, file_id)
    return content, media_type, filename
