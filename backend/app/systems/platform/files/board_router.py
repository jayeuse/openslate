"""Board-scoped admission for unattached private files."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response
from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from app.common.dependencies import (
    require_fresh_exact_admin,
    require_legacy_capability,
    require_roles,
)
from app.common.listing import execute_standard_list
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.access.users.permissions import Capability
from app.systems.boards.attachment_models import (
    BoardAnnouncementRevisionAttachment,
    BoardContentAttachment,
)
from app.systems.platform.files import service
from app.systems.platform.files.access import authorize_board_file, error, fresh_user, load
from app.systems.platform.files.lifecycle_router import purge_impact
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import StorageBackend, hold_file_worker
from app.systems.platform.files.purge import purge_confirmed
from app.systems.platform.files.router import SPEC
from app.systems.platform.files.schemas import (
    BoardFileCreate,
    BoardFileListRequest,
    FileListResponse,
    FileResponse,
)
from app.systems.platform.files.storage import get_storage
from app.systems.sandbox.lifecycle.exceptions import LifecycleError
from app.systems.sandbox.lifecycle.schemas import (
    LifecyclePurgePreviewResponse,
    LifecyclePurgeRequest,
)
from app.systems.sandbox.lifecycle.service import (
    challenge_impact_digest,
    issue_challenge,
    verify_challenge,
)


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["board files"], dependencies=[Depends(_private_cache)])
Writer = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_WRITE))]
Admin = Annotated[User, Depends(require_roles("admin"))]
Database = Annotated[Session, Depends(get_db)]
Store = Annotated[StorageBackend, Depends(get_storage)]


def _unlinked(db: Session, actor: User, board_id: UUID, file_id: UUID) -> File:
    authorize_board_file(db, fresh_user(db, actor.id), board_id, write=True)
    file = load(db, file_id)
    if file.board_id != board_id or file.purpose != "board_attachment":
        raise error("file_not_found", "File not found", 404)
    active = db.scalar(
        select(BoardContentAttachment.id).where(
            BoardContentAttachment.file_id == file_id,
            BoardContentAttachment.is_linked.is_(True),
        )
    )
    published = db.scalar(
        select(BoardAnnouncementRevisionAttachment.id).where(
            BoardAnnouncementRevisionAttachment.file_id == file_id
        )
    )
    if active is not None or published is not None:
        raise error("file_not_found", "File not found", 404)
    return file


@router.post("/{board_id}/files", response_model=FileResponse, status_code=201)
def reserve_board_file(
    board_id: UUID,
    payload: BoardFileCreate,
    actor: Writer,
    db: Database,
    response: Response,
) -> FileResponse:
    item = service.reserve_board(db, actor, board_id, payload)
    response.headers["Location"] = f"/api/boards/{board_id}/files/{item.id}"
    return item


@router.get("/{board_id}/files", response_model=FileListResponse)
def list_unlinked_board_files(
    board_id: UUID,
    params: Annotated[BoardFileListRequest, Query()],
    actor: Writer,
    db: Database,
) -> FileListResponse:
    authorize_board_file(db, fresh_user(db, actor.id), board_id, write=True)
    active = exists(
        select(BoardContentAttachment.id).where(
            BoardContentAttachment.file_id == File.id,
            BoardContentAttachment.is_linked.is_(True),
        )
    )
    published = exists(
        select(BoardAnnouncementRevisionAttachment.id).where(
            BoardAnnouncementRevisionAttachment.file_id == File.id
        )
    )
    statement = select(File).where(
        File.board_id == board_id, File.purpose == "board_attachment", ~active, ~published
    )
    result = execute_standard_list(db, statement, params, SPEC)
    return FileListResponse.model_validate({"items": result.items, "pagination": result.pagination})


@router.get("/{board_id}/files/{file_id}", response_model=FileResponse)
def get_unlinked_board_file(
    board_id: UUID, file_id: UUID, actor: Writer, db: Database
) -> FileResponse:
    return FileResponse.model_validate(_unlinked(db, actor, board_id, file_id))


@router.put("/{board_id}/files/{file_id}/content", response_model=FileResponse)
def upload_unlinked_board_file(
    request: Request,
    board_id: UUID,
    file_id: UUID,
    actor: Writer,
    db: Database,
    storage: Store,
    content: Annotated[bytes, Body(media_type="application/octet-stream")],
) -> FileResponse:
    _unlinked(db, actor, board_id, file_id)
    with hold_file_worker(request):
        return service.upload(db, actor.id, file_id, content, storage, board_id=board_id)


@router.post("/{board_id}/files/{file_id}/scan", response_model=FileResponse, status_code=202)
def scan_unlinked_board_file(
    board_id: UUID,
    file_id: UUID,
    actor: Writer,
    db: Database,
    response: Response,
) -> FileResponse:
    _unlinked(db, actor, board_id, file_id)
    response.headers["Location"] = f"/api/boards/{board_id}/files/{file_id}"
    return service.scan(db, actor.id, file_id, board_id=board_id)


@router.post("/{board_id}/files/{file_id}/archive", response_model=FileResponse)
def archive_unlinked_board_file(
    board_id: UUID, file_id: UUID, actor: Writer, db: Database
) -> FileResponse:
    _unlinked(db, actor, board_id, file_id)
    return service.archive(db, actor.id, file_id, board_id=board_id)


@router.post("/{board_id}/files/{file_id}/reopen", response_model=FileResponse)
def reopen_unlinked_board_file(
    board_id: UUID, file_id: UUID, actor: Writer, db: Database
) -> FileResponse:
    _unlinked(db, actor, board_id, file_id)
    return service.archive(db, actor.id, file_id, board_id=board_id, reopen=True)


@router.post("/{board_id}/files/{file_id}/reconcile", response_model=FileResponse)
def reconcile_unlinked_board_file(
    request: Request,
    board_id: UUID,
    file_id: UUID,
    actor: Admin,
    db: Database,
    storage: Store,
) -> FileResponse:
    require_fresh_exact_admin(db, actor.id)
    file = load(db, file_id)
    if file.board_id != board_id or file.purpose != "board_attachment":
        raise error("file_not_found", "File not found", 404)
    with hold_file_worker(request):
        return service.reconcile(db, actor.id, file_id, storage, board_id=board_id)


def _mapped(exc: LifecycleError) -> HTTPException:
    return HTTPException(exc.status_code, detail={"code": str(exc.code), "message": exc.detail})


@router.post(
    "/{board_id}/files/{file_id}/purge/preview", response_model=LifecyclePurgePreviewResponse
)
def preview_board_file_purge(
    board_id: UUID, file_id: UUID, actor: Admin, db: Database
) -> LifecyclePurgePreviewResponse:
    require_fresh_exact_admin(db, actor.id)
    impact = purge_impact(db, actor.id, file_id, board_id=board_id)
    try:
        issued = issue_challenge(db, actor.id, "purge", "file", file_id, impact.impact_digest)
    except LifecycleError as exc:
        raise _mapped(exc) from exc
    return LifecyclePurgePreviewResponse(
        impact=impact,
        token=issued.token,
        expires_at=issued.expires_at,
        confirmation_name=str(file_id),
    )


@router.post("/{board_id}/files/{file_id}/purge", response_model=FileResponse)
def execute_board_file_purge(
    request: Request,
    board_id: UUID,
    file_id: UUID,
    payload: LifecyclePurgeRequest,
    actor: Admin,
    db: Database,
    storage: Store,
) -> FileResponse:
    with hold_file_worker(request):
        if payload.confirmation_name != str(file_id):
            raise error("confirmation_name_mismatch", "Confirmation must match the file ID", 422)
        try:
            digest = challenge_impact_digest(db, payload.token, actor.id, "purge", "file", file_id)
            challenge = verify_challenge(
                db,
                payload.token,
                actor.id,
                "purge",
                "file",
                file_id,
                digest,
                actor.email,
                payload.password,
            )
            expected = challenge.impact_digest
        except LifecycleError as exc:
            raise _mapped(exc) from exc

        def validate_locked() -> None:
            impact = purge_impact(db, actor.id, file_id, board_id=board_id)
            if impact.impact_digest != expected:
                db.rollback()
                raise error("plan_drift", "File changed after preview; obtain a new preview")

        return purge_confirmed(
            db,
            actor.id,
            file_id,
            storage,
            validate_locked=validate_locked,
            board_id=board_id,
        )
