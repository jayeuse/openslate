"""Durable intent around external I/O; no SQL transaction crosses a provider call."""

from datetime import UTC, datetime, timedelta
from hashlib import sha256
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import require_fresh_exact_admin
from app.systems.access.users.models import User, UserRole
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import (
    SecurityEventPersistenceError,
    append_committed_security_event,
)
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.files.access import (
    authorize,
    authorize_board_file,
    authorize_contextual_file,
    error,
    fresh_user,
    load,
    parent,
    require_unlinked,
)
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import (
    ProviderRejected,
    ProviderUnavailable,
    ProviderWriteRejected,
    StorageBackend,
)
from app.systems.platform.files.quota import (
    RESERVATION_TTL,
    lock_quota,
    require_capacity,
    require_live_reservation,
)
from app.systems.platform.files.schemas import BoardFileCreate, FileCreate, FileResponse
from app.systems.platform.files.validation_worker import validate_bounded


def expire_unused_reservations(db: Session, now: datetime) -> int:
    """Purge stale empty reservations, committing each row; call before ``lock_quota``.

    The quota lock is transaction-scoped, so these commits would release it. Expiry only
    lowers occupancy and needs no quota lock. The rows can belong to anyone, so they are
    audited as system work; the caller's audit context is restored before returning.
    """
    caller = db.info.get(AUDIT_CONTEXT_KEY)
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        request_id=uuid7(), request_method="SYSTEM", request_path="/internal/files/expire"
    )
    try:
        return _expire(db, now)
    finally:
        if caller is None:
            db.info.pop(AUDIT_CONTEXT_KEY, None)
        else:
            db.info[AUDIT_CONTEXT_KEY] = caller


def _expire(db: Session, now: datetime) -> int:
    identities = list(
        db.scalars(
            select(File.id)
            .where(
                File.state == "awaiting_upload",
                File.created_at <= now - RESERVATION_TTL,
                File.operation_id.is_(None),
                File.digest.is_(None),
                File.actual_size.is_(None),
            )
            .order_by(File.created_at, File.id)
            .limit(100)
        )
    )
    expired = 0
    for identity in identities:
        try:
            file = load(db, identity, lock=True)
        except OperationalError as exc:
            db.rollback()
            if getattr(exc.orig, "sqlstate", None) == "55P03":
                continue
            raise
        except HTTPException:
            # A closed or missing parent must not block every new reservation.
            db.rollback()
            continue
        if (
            file.state != "awaiting_upload"
            or file.operation_id is not None
            or file.digest is not None
            or file.actual_size is not None
            or file.created_at > now - RESERVATION_TTL
        ):
            continue
        file.state = "purged"
        file.is_deleted = True
        file.deleted_at = now
        file.failure_code = "file_reservation_expired"
        db.commit()
        expired += 1
    db.rollback()
    return expired


def reserve(db: Session, user: User, payload: FileCreate) -> FileResponse:
    authorize(
        db,
        user,
        payload.purpose,
        write=True,
        record_id=payload.record_id,
        department_id=payload.department_id,
    )
    # Authorization takes no locks, so the expiry commits cannot release any.
    expire_unused_reservations(db, datetime.now(UTC))
    lock_quota(db)
    # Expiry may commit; recheck the current actor and grants at final admission.
    authorize(
        db,
        fresh_user(db, user.id),
        payload.purpose,
        write=True,
        record_id=payload.record_id,
        department_id=payload.department_id,
    )
    require_capacity(db, payload.purpose, payload.expected_size)
    parent(db, payload.record_id, active=True, lock=True, department_id=payload.department_id)
    file = File(
        **payload.model_dump(), creator_id=user.id, object_key=uuid4().hex, state="awaiting_upload"
    )
    db.add(file)
    db.commit()
    return FileResponse.model_validate(file)


def reserve_board(
    db: Session, user: User, board_id: UUID, payload: BoardFileCreate
) -> FileResponse:
    """Reserve pending-upload capacity only after the owning Board permits editing."""
    # Unlocked check first, so a caller without Board access triggers no expiry commits.
    authorize_board_file(db, fresh_user(db, user.id), board_id, write=True)
    expire_unused_reservations(db, datetime.now(UTC))
    lock_quota(db)
    authorize_board_file(db, fresh_user(db, user.id), board_id, write=True, lock=True)
    require_capacity(db, "board_attachment", payload.expected_size)
    file = File(
        purpose="board_attachment",
        board_id=board_id,
        record_id=None,
        creator_id=user.id,
        filename=payload.filename,
        expected_size=payload.expected_size,
        object_key=uuid4().hex,
        state="awaiting_upload",
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
    db: Session,
    actor_id: UUID,
    file_id: UUID,
    content: bytes,
    storage: StorageBackend,
    *,
    board_id: UUID | None = None,
) -> FileResponse:
    candidate = load(db, file_id)
    authorize_contextual_file(
        db, fresh_user(db, actor_id), candidate, board_id=board_id, write=True
    )
    file = load(db, file_id, active_parent=True, lock=True)
    authorize_contextual_file(db, fresh_user(db, actor_id), file, board_id=board_id, write=True)
    if file.is_deleted or file.state != "awaiting_upload":
        raise error("file_upload_conflict", "File cannot accept an upload")
    require_live_reservation(file)
    if len(content) != file.expected_size:
        raise error("file_size_mismatch", "Uploaded size differs from reserved size", 422)
    filename, logo = file.filename, file.purpose == "workspace_logo"
    db.rollback()
    validated = validate_bounded(filename, content, logo=logo)
    candidate = load(db, file_id)
    authorize_contextual_file(
        db, fresh_user(db, actor_id), candidate, board_id=board_id, write=True
    )
    file = load(db, file_id, active_parent=True, lock=True)
    authorize_contextual_file(db, fresh_user(db, actor_id), file, board_id=board_id, write=True)
    if file.is_deleted or file.state != "awaiting_upload":
        raise error("file_upload_conflict", "File cannot accept an upload")
    require_live_reservation(file)
    file.actual_size = len(validated.content)
    file.media_type = validated.media_type
    file.digest = sha256(validated.content).hexdigest()
    token = _claim(db, file, "uploading")
    key = file.object_key
    db.commit()
    try:
        storage.upload(key, validated.content, validated.media_type)
    except ProviderWriteRejected as exc:
        # The local filesystem proved no immutable object was installed. Release capacity so
        # callers can create a fresh reservation; only post-install uncertainty is reconciled.
        file = _current(db, file_id, token, "uploading")
        file.state = "purged"
        file.is_deleted = True
        file.deleted_at = datetime.now(UTC)
        file.failure_code = "upload_storage_unavailable"
        file.operation_id = None
        file.operation_expires_at = None
        file.actual_size = None
        file.digest = None
        file.media_type = None
        db.commit()
        raise error(
            "upload_storage_unavailable",
            "Storage could not accept this upload; create a new upload and retry",
            503,
        ) from exc
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
    candidate = load(db, file_id)
    authorize_contextual_file(
        db, fresh_user(db, actor_id), candidate, board_id=board_id, write=True
    )
    file = _current(db, file_id, token, "uploading")
    authorize_contextual_file(db, fresh_user(db, actor_id), file, board_id=board_id, write=True)
    parent(
        db, file.record_id, active=True, board_id=file.board_id, department_id=file.department_id
    )
    if file.is_deleted:
        raise error("file_archived", "File was archived during upload")
    _finish_ready(file)
    db.commit()
    return FileResponse.model_validate(file)


def _finish_ready(file: File) -> None:
    """The exact validated bytes are stored, so the file is downloadable."""
    file.state = "ready"
    file.operation_id = None
    file.operation_expires_at = None
    file.failure_code = None


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
        )
    file = load(db, file_id, lock=True, shared_lock=True)
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
    candidate = load(db, file_id)
    fresh_actor = fresh_user(db, actor_id)
    if not current_logo:
        authorize(
            db,
            fresh_actor,
            candidate.purpose,
            record_id=candidate.record_id,
            department_id=candidate.department_id,
        )
    file = load(db, file_id, lock=True, shared_lock=True)
    if current_logo and file.is_deleted:
        raise error("file_not_found", "Logo not found", 404)
    if file.state != "ready":
        raise error("file_not_ready", "File is not available")
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


def archive(
    db: Session,
    actor_id: UUID,
    file_id: UUID,
    *,
    reopen: bool = False,
    board_id: UUID | None = None,
) -> FileResponse:
    candidate = load(db, file_id)
    authorize_contextual_file(
        db,
        fresh_user(db, actor_id),
        candidate,
        board_id=board_id,
        write=True,
        manage=candidate.purpose == "library_document",
    )
    file = load(db, file_id, active_parent=reopen, lock=True)
    authorize_contextual_file(
        db,
        fresh_user(db, actor_id),
        file,
        board_id=board_id,
        write=True,
        manage=file.purpose == "library_document",
    )
    if file.purpose == "board_attachment":
        require_unlinked(db, file.id)
    if file.state in {"deleting", "purged"}:
        raise error("file_archive_conflict", "File is being permanently removed")
    file.is_deleted = not reopen
    file.deleted_at = None if reopen else datetime.now(UTC)
    db.commit()
    return FileResponse.model_validate(file)


def reconcile(
    db: Session,
    actor_id: UUID,
    file_id: UUID,
    storage: StorageBackend,
    *,
    board_id: UUID | None = None,
) -> FileResponse:
    token: UUID | None
    lock_quota(db)
    require_fresh_exact_admin(db, actor_id)
    fresh_user(db, actor_id)
    candidate = load(db, file_id)
    if candidate.purpose == "workspace_logo":
        profile = db.scalar(
            select(WorkspaceProfile)
            .with_for_update(nowait=True)
            .execution_options(populate_existing=True)
        )
        if profile is None:
            raise error("workspace_unavailable", "Workspace configuration is unavailable", 503)
        if profile.logo_file_id == file_id:
            raise error("file_current_logo", "Replace or remove the current logo before purging")
    file = load(db, file_id, lock=True)
    if file.purpose == "board_attachment":
        if board_id is None or file.board_id != board_id:
            raise error("file_not_found", "File not found", 404)
        require_unlinked(db, file.id)
    elif board_id is not None:
        raise error("file_not_found", "File not found", 404)
    if file.state == "deleting":
        from app.systems.platform.files.purge import (
            DeletionClaim,
            delete_and_finalize,
            purge_confirmed,
        )

        if file.deletion_origin == "logo_replacement":
            if not file.is_deleted or file.operation_id is None:
                raise error("file_operation_stale", "File operation changed; refresh its status")
            if file.operation_expires_at is not None and file.operation_expires_at > datetime.now(
                UTC
            ):
                raise error("file_operation_active", "Deletion is still active")
            token = _claim(db, file, "deleting")
            claim = DeletionClaim(file.id, file.object_key, token, actor_id)
            db.commit()
            return delete_and_finalize(db, claim, storage)
        return purge_confirmed(db, actor_id, file_id, storage, board_id=board_id)
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
        if fresh_user(db, actor_id).role != UserRole.ADMIN.value:
            raise error("forbidden", "Forbidden", 403)
        _finish_ready(file)
        db.commit()
    return FileResponse.model_validate(file)
