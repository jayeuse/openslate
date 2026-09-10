from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user, require_fresh_exact_admin
from app.core.database import get_db
from app.systems.files import service as file_service
from app.systems.files.models import File
from app.systems.files.providers import Storage, hold_file_worker
from app.systems.files.storage import get_storage
from app.systems.users.models import User
from app.systems.workspace.models import WorkspaceProfile
from app.systems.workspace.schemas import WorkspaceResponse, WorkspaceUpdate

router = APIRouter(prefix="/workspace", tags=["workspace"])
WorkspaceReadUser = Annotated[User, Depends(get_current_user)]
StorageDependency = Annotated[Storage, Depends(get_storage)]


def _workspace_unavailable() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "code": "workspace_unavailable",
            "message": "Workspace configuration is unavailable",
        },
    )


def _stale_revision() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"code": "stale_revision", "message": "Workspace configuration has changed"},
    )


def _logo_not_ready() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"code": "logo_not_ready", "message": "Workspace logo is not available"},
    )


def _logo_not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"code": "logo_not_found", "message": "Workspace logo is not configured"},
    )


def _workspace(
    db: Session,
    *,
    lock: bool = False,
    shared_lock: bool = False,
) -> WorkspaceProfile:
    statement = select(WorkspaceProfile).where(WorkspaceProfile.singleton_key.is_(True))
    if lock:
        statement = statement.with_for_update(read=shared_lock)
    profile = db.scalar(statement)
    if not isinstance(profile, WorkspaceProfile):
        raise _workspace_unavailable()
    return profile


def _ready_logo(
    db: Session,
    file_id: UUID,
    *,
    lock: bool = False,
    shared_lock: bool = False,
) -> File:
    statement = select(File).where(File.id == file_id)
    if lock:
        statement = statement.with_for_update(read=shared_lock)
    file = db.scalar(statement)
    if not isinstance(file, File):
        raise _logo_not_ready()
    if (
        file.purpose != "workspace_logo"
        or file.is_deleted
        or file.state != "ready"
        or file.actual_size is None
        or not file.digest
        or not file.scanner_version
        or not file.signature_version
    ):
        raise _logo_not_ready()
    return file


@router.get("", response_model=WorkspaceResponse)
def get_workspace(
    _: WorkspaceReadUser,
    db: Annotated[Session, Depends(get_db)],
) -> WorkspaceProfile:
    return _workspace(db)


@router.patch("", response_model=WorkspaceResponse)
def update_workspace(
    payload: WorkspaceUpdate,
    actor: WorkspaceReadUser,
    db: Annotated[Session, Depends(get_db)],
) -> WorkspaceProfile:
    require_fresh_exact_admin(db, actor.id)
    try:
        profile = _workspace(db, lock=True)
    except SQLAlchemyError as error:
        db.rollback()
        raise _workspace_unavailable() from error
    if payload.revision != profile.revision:
        raise _stale_revision()
    if "logo_file_id" in payload.model_fields_set and payload.logo_file_id is not None:
        _ready_logo(db, payload.logo_file_id, lock=True)

    for field in payload.model_fields_set - {"revision"}:
        setattr(profile, field, getattr(payload, field))
    profile.revision += 1
    profile.performed_by = actor.id
    try:
        db.commit()
    except (IntegrityError, SQLAlchemyError) as error:
        db.rollback()
        raise _workspace_unavailable() from error
    return profile


@router.get("/logo")
def get_workspace_logo(
    request: Request,
    user: WorkspaceReadUser,
    db: Annotated[Session, Depends(get_db)],
    storage: StorageDependency,
) -> Response:
    with hold_file_worker(request):
        return _deliver_workspace_logo(user, db, storage)


def _deliver_workspace_logo(user: User, db: Session, storage: Storage) -> Response:
    profile = _workspace(db, lock=True, shared_lock=True)
    logo_file_id = profile.logo_file_id
    if logo_file_id is None:
        raise _logo_not_found()
    _ready_logo(db, logo_file_id, lock=True, shared_lock=True)
    content, media_type, _ = file_service.download(
        db,
        user.id,
        logo_file_id,
        storage,
        current_logo=True,
    )
    current_profile = _workspace(db, lock=True, shared_lock=True)
    if current_profile.logo_file_id != logo_file_id:
        raise _logo_not_found()
    _ready_logo(db, logo_file_id, lock=True, shared_lock=True)
    return Response(
        content,
        media_type=media_type,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )
