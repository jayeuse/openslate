"""Durable scan scheduling using only the file inventory row."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.orm import Session

from app.systems.platform.files.access import (
    authorize_contextual_file,
    error,
    fresh_user,
    load,
)
from app.systems.platform.files.models import File
from app.systems.platform.files.schemas import FileResponse

RETRY_DELAYS = (30, 120, 600, 1800)
MAX_ATTEMPTS = 5
LEASE_SECONDS = 240
UNRESOLVED = "scan_execution_unresolved"
PROMOTION_UNRESOLVED = "promotion_metadata_unresolved"


def enqueue_uploaded(file: File, *, now: datetime | None = None) -> None:
    """Finalize the exact admitted upload and schedule its captured requester."""
    file.state = "pending_scan"
    file.operation_id = None
    file.operation_expires_at = None
    file.scan_attempts = 0
    file.scan_next_attempt_at = now or datetime.now(UTC) if file.scan_requested_by else None
    file.failure_code = None if file.scan_requested_by else "scan_adoption_required"


def request_scan(
    db: Session, actor_id: UUID, file_id: UUID, *, board_id: UUID | None = None
) -> FileResponse:
    candidate = load(db, file_id, active_parent=True)
    authorize_contextual_file(
        db, fresh_user(db, actor_id), candidate, board_id=board_id, write=True
    )
    file = load(db, file_id, active_parent=True, lock=True)
    authorize_contextual_file(db, fresh_user(db, actor_id), file, board_id=board_id, write=True)
    if file.is_deleted or file.state != "pending_scan":
        raise error("file_scan_conflict", "File is not awaiting scanning")
    if file.failure_code == UNRESOLVED:
        raise error(UNRESOLVED, "Scanner execution requires operator recovery")
    if file.operation_id is not None:
        # Do not steal active claims, reset attempts, or replace their requester.
        return FileResponse.model_validate(file)
    if file.scan_next_attempt_at is not None and file.scan_requested_by is not None:
        return FileResponse.model_validate(file)
    file.scan_requested_by = actor_id
    file.scan_attempts = 0
    file.scan_next_attempt_at = datetime.now(UTC)
    file.failure_code = None
    db.commit()
    return FileResponse.model_validate(file)
