"""File purge confirmation reuses the existing password challenge mechanism."""

import hashlib
import json
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.dependencies import require_admin, require_fresh_exact_admin
from app.core.config import get_settings
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.files.access import error, load, require_unlinked
from app.systems.platform.files.providers import StorageBackend, hold_file_worker
from app.systems.platform.files.purge import purge_confirmed
from app.systems.platform.files.schemas import FileResponse
from app.systems.platform.files.storage import get_storage
from app.systems.sandbox.lifecycle.exceptions import LifecycleError
from app.systems.sandbox.lifecycle.planner import canonical_lifecycle_digest
from app.systems.sandbox.lifecycle.purge_support import (
    PURGE_DISABLED_MESSAGE,
    last_successful_backup_at,
)
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleImpactResponse,
    LifecycleOperation,
    LifecyclePurgePreviewResponse,
    LifecyclePurgeRequest,
    LifecycleRowState,
    LifecycleTargetType,
)
from app.systems.sandbox.lifecycle.service import (
    challenge_impact_digest,
    issue_challenge,
    verify_challenge,
)

router = APIRouter(prefix="/files", tags=["files"])
Admin = Annotated[User, Depends(require_admin)]
DB = Annotated[Session, Depends(get_db)]


def purge_impact(
    db: Session, actor_id: UUID, file_id: UUID, *, board_id: UUID | None = None
) -> LifecycleImpactResponse:
    if not get_settings().lifecycle_purge_enabled:
        raise error("purge_disabled", PURGE_DISABLED_MESSAGE, 403)
    # Workspace mutations lock profile before file; use that same order.
    profile = db.scalar(
        select(WorkspaceProfile)
        .with_for_update(nowait=True)
        .execution_options(populate_existing=True)
    )
    if profile is not None and profile.logo_file_id == file_id:
        raise error("file_current_logo", "Replace or remove the current logo before purging")
    file = load(db, file_id, lock=True)
    if file.purpose == "board_attachment":
        if board_id is None or file.board_id != board_id:
            raise error("file_not_found", "File not found", 404)
        require_unlinked(db, file.id)
    elif board_id is not None:
        raise error("file_not_found", "File not found", 404)
    if not file.is_deleted:
        raise error("close_required", "Archive the file before purging")
    if file.state == "uploading" or file.operation_id is not None:
        raise error("file_operation_active", "Reconcile the active file operation before purging")
    if file.state in {"deleting", "purged"}:
        raise error("file_purge_started", "Purge has already started; reconcile this file")
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "filename": file.filename,
                "key": file.object_key,
                "digest": file.digest,
                "state": file.state,
                "operation": str(file.operation_id),
                "purpose": file.purpose,
                "parent": str(file.record_id),
                "board": str(file.board_id),
                "department": str(file.department_id),
                "bytes": file.actual_size,
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()
    row = LifecycleRowState(
        entity_type="file",
        entity_id=file.id,
        is_deleted=file.is_deleted,
        deleted_at=file.deleted_at,
        updated_at=file.updated_at,
        state_fingerprint=fingerprint,
    )
    digest = canonical_lifecycle_digest(
        LifecycleOperation.PURGE, LifecycleTargetType.FILE, file_id, actor_id, [row]
    )
    return LifecycleImpactResponse(
        target_type=LifecycleTargetType.FILE,
        target_id=file_id,
        operation=LifecycleOperation.PURGE,
        actor_id=actor_id,
        rows=[row],
        impact_digest=digest,
    )


def _mapped(exc: LifecycleError) -> HTTPException:
    return HTTPException(exc.status_code, detail={"code": str(exc.code), "message": exc.detail})


@router.post("/{file_id}/purge/preview", response_model=LifecyclePurgePreviewResponse)
def preview(
    file_id: UUID, user: Admin, db: DB, response: Response
) -> LifecyclePurgePreviewResponse:
    response.headers["Cache-Control"] = "no-store"
    actor_id = user.id
    require_fresh_exact_admin(db, actor_id)
    impact = purge_impact(db, actor_id, file_id)
    try:
        issued = issue_challenge(db, actor_id, "purge", "file", file_id, impact.impact_digest)
    except LifecycleError as exc:
        raise _mapped(exc) from exc
    return LifecyclePurgePreviewResponse(
        impact=impact,
        token=issued.token,
        expires_at=issued.expires_at,
        confirmation_name=load(db, file_id).filename,
        last_successful_backup_at=last_successful_backup_at(db),
    )


@router.post("/{file_id}/purge", response_model=FileResponse)
def execute(
    request: Request,
    file_id: UUID,
    payload: LifecyclePurgeRequest,
    user: Admin,
    db: DB,
    storage: Annotated[StorageBackend, Depends(get_storage)],
    response: Response,
) -> FileResponse:
    with hold_file_worker(request):
        response.headers["Cache-Control"] = "no-store"
        actor_id, email = user.id, user.email
        if payload.confirmation_name != load(db, file_id).filename:
            raise error("confirmation_name_mismatch", "Confirmation must match the file name", 422)
        if not get_settings().lifecycle_purge_enabled:
            raise error("purge_disabled", PURGE_DISABLED_MESSAGE, 403)
        try:
            digest = challenge_impact_digest(db, payload.token, actor_id, "purge", "file", file_id)
            challenge = verify_challenge(
                db,
                payload.token,
                actor_id,
                "purge",
                "file",
                file_id,
                digest,
                email,
                payload.password,
            )
            expected = challenge.impact_digest
        except LifecycleError as exc:
            raise _mapped(exc) from exc

        # purge_confirmed invokes this under the same locks as its state transition.
        def validate_locked() -> None:
            impact = purge_impact(db, actor_id, file_id)
            if payload.confirmation_name != load(db, file_id).filename:
                raise error(
                    "confirmation_name_mismatch", "Confirmation must match the file name", 422
                )
            if impact.impact_digest != expected:
                db.rollback()
                raise error("plan_drift", "File changed after preview; obtain a new preview")

        return purge_confirmed(db, actor_id, file_id, storage, validate_locked=validate_locked)
