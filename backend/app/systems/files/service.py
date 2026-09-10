"""Durable intent around external I/O; no SQL transaction crosses a provider call."""

from datetime import UTC, datetime, timedelta
from hashlib import sha256
from uuid import UUID, uuid4

from sqlalchemy.orm import Session

from app.systems.audit.models import SecurityEventOutcome
from app.systems.audit.schemas import SecurityEventIngestRequest
from app.systems.audit.service import SecurityEventPersistenceError, append_committed_security_event
from app.systems.files.access import authorize, error, fresh_user, load, parent
from app.systems.files.models import File
from app.systems.files.providers import ProviderRejected, ProviderUnavailable, Storage
from app.systems.files.quota import lock_quota, require_capacity, require_live_reservation
from app.systems.files.schemas import FileCreate, FileResponse
from app.systems.files.validation_worker import validate_bounded
from app.systems.users.models import User


def reserve(db: Session, user: User, payload: FileCreate) -> FileResponse:
    authorize(user, payload.purpose, write=True)
    lock_quota(db)
    require_capacity(db, payload.purpose, payload.expected_size)
    parent(db, payload.record_id, active=True, lock=True)
    file = File(
        **payload.model_dump(), creator_id=user.id, object_key=uuid4().hex, state="awaiting_upload"
    )
    db.add(file)
    db.commit()
    return FileResponse.model_validate(file)


def _claim(db: Session, file: File, state: str) -> UUID:
    token = uuid4()
    file.state = state
    file.operation_id = token
    file.operation_expires_at = datetime.now(UTC) + timedelta(seconds=120)
    file.failure_code = None
    return token


def _current(db: Session, file_id: UUID, token: UUID, state: str) -> File:
    file = load(db, file_id, lock=True)
    if file.operation_id != token or file.state != state:
        raise error("file_operation_stale", "File operation changed; refresh its status")
    return file


def upload(
    db: Session, actor_id: UUID, file_id: UUID, content: bytes, storage: Storage
) -> FileResponse:
    file = load(db, file_id, active_parent=True, lock=True)
    authorize(fresh_user(db, actor_id), file.purpose, write=True)
    if file.is_deleted or file.state != "awaiting_upload":
        raise error("file_upload_conflict", "File cannot accept an upload")
    require_live_reservation(file)
    if len(content) != file.expected_size:
        raise error("file_size_mismatch", "Uploaded size differs from reserved size", 422)
    filename, logo = file.filename, file.purpose == "workspace_logo"
    db.rollback()
    validated = validate_bounded(filename, content, logo=logo)
    file = load(db, file_id, active_parent=True, lock=True)
    authorize(fresh_user(db, actor_id), file.purpose, write=True)
    if file.is_deleted or file.state != "awaiting_upload":
        raise error("file_upload_conflict", "File cannot accept an upload")
    require_live_reservation(file)
    file.scan_requested_by = actor_id
    file.actual_size = len(validated.content)
    file.media_type = validated.media_type
    file.digest = sha256(validated.content).hexdigest()
    token = _claim(db, file, "uploading")
    key = file.object_key
    db.commit()
    try:
        storage.upload(key, validated.content, validated.media_type)
    except ProviderRejected as exc:
        file = _current(db, file_id, token, "uploading")
        file.state = "rejected"
        file.failure_code = "upload_rejected"
        file.operation_id = None
        file.operation_expires_at = None
        db.commit()
        raise error("upload_rejected", "Storage rejected this upload", 422) from exc
    except ProviderUnavailable as exc:
        # Even a timeout may finish upstream. Preserve uploading and immutable identity.
        file = _current(db, file_id, token, "uploading")
        file.failure_code = "upload_unresolved"
        db.commit()
        raise error(
            "upload_unresolved", "Upload outcome needs administrator reconciliation", 503
        ) from exc
    file = _current(db, file_id, token, "uploading")
    authorize(fresh_user(db, actor_id), file.purpose, write=True)
    parent(db, file.record_id, active=True)
    if file.is_deleted:
        raise error("file_archived", "File was archived during upload")
    from app.systems.files.scan_queue import enqueue_uploaded

    enqueue_uploaded(file)
    db.commit()
    return FileResponse.model_validate(file)


def scan(db: Session, actor_id: UUID, file_id: UUID) -> FileResponse:
    """Enqueue or adopt a retry; processing happens only in the deployment worker."""
    from app.systems.files.scan_queue import request_scan

    return request_scan(db, actor_id, file_id)


def download(
    db: Session, actor_id: UUID, file_id: UUID, storage: Storage, *, current_logo: bool = False
) -> tuple[bytes, str, str]:
    file = load(db, file_id, lock=True, shared_lock=True)
    user = fresh_user(db, actor_id)
    if current_logo:
        # Caller must check the profile reference under its lock first.
        if file.purpose != "workspace_logo" or file.is_deleted:
            raise error("file_not_found", "Logo not found", 404)
    else:
        authorize(user, file.purpose)
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
    # Recheck after provider latency, including a concurrent deletion/admission change.
    file = load(db, file_id, lock=True, shared_lock=True)
    if file.state != "ready":
        raise error("file_not_ready", "File is not available")
    fresh_actor = fresh_user(db, actor_id)
    if current_logo and file.is_deleted:
        raise error("file_not_found", "Logo not found", 404)
    if not current_logo:
        authorize(fresh_actor, file.purpose)
    db.commit()
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
    return content, media_type, filename


def archive(db: Session, actor_id: UUID, file_id: UUID, *, reopen: bool = False) -> FileResponse:
    file = load(db, file_id, active_parent=reopen, lock=True)
    authorize(fresh_user(db, actor_id), file.purpose, write=True)
    if file.state in {"deleting", "purged"}:
        raise error("file_archive_conflict", "File is being permanently removed")
    file.is_deleted = not reopen
    file.deleted_at = None if reopen else datetime.now(UTC)
    db.commit()
    return FileResponse.model_validate(file)


def reconcile(db: Session, actor_id: UUID, file_id: UUID, storage: Storage) -> FileResponse:
    lock_quota(db)
    user = fresh_user(db, actor_id)
    authorize(user, "library_document", write=True)
    file = load(db, file_id, lock=True)
    if file.failure_code == "scan_execution_unresolved":
        raise error("scan_execution_unresolved", "Scanner execution requires operator recovery")
    if file.state == "deleting":
        from app.systems.files.purge import purge_confirmed

        return purge_confirmed(db, actor_id, file_id, storage)
    if file.state == "uploading":
        key, digest, size, token = file.object_key, file.digest, file.actual_size, file.operation_id
        db.commit()
        try:
            content = storage.download(key)
        except ProviderUnavailable as exc:
            raise error("upload_unresolved", "Upload outcome remains unresolved", 503) from exc
        if content is None or sha256(content).hexdigest() != digest or len(content) != size:
            raise error("upload_unresolved", "Upload outcome remains unresolved", 409)
        # Presence of the exact immutable object establishes the admitted write succeeded.
        # Another late non-overwriting write can only conflict, never replace these bytes.
        if token is None:
            raise error("upload_unresolved", "Upload outcome remains unresolved")
        file = _current(db, file_id, token, "uploading")
        authorize(fresh_user(db, actor_id), "library_document", write=True)
        from app.systems.files.scan_queue import enqueue_uploaded

        enqueue_uploaded(file)
        db.commit()
    elif file.state == "pending_scan" and file.operation_id is not None:
        raise error("scan_execution_unresolved", "Scanner execution requires operator recovery")
    return FileResponse.model_validate(file)
