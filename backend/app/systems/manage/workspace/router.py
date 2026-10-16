from contextlib import nullcontext
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user, require_fresh_exact_admin
from app.core.database import get_db
from app.systems.access.users.membership import bound_organization, require_current_membership
from app.systems.access.users.models import User
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.manage.workspace.schemas import (
    WorkspaceAppearanceResponse,
    WorkspaceGuestResponse,
    WorkspaceResponse,
    WorkspaceUpdate,
)
from app.systems.platform.files import service as file_service
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import (
    ProviderUnavailable,
    Storage,
    hold_file_worker,
    transfer_slot,
)
from app.systems.platform.files.purge import (
    DeletionClaim,
    claim_logo_replacement,
    delete_and_finalize,
)
from app.systems.platform.files.quota import lock_quota
from app.systems.platform.files.storage import get_storage

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
    nowait: bool = False,
) -> WorkspaceProfile:
    statement = select(WorkspaceProfile).where(WorkspaceProfile.id == bound_organization(db))
    if lock:
        statement = statement.with_for_update(read=shared_lock, nowait=nowait)
    profiles = db.scalars(statement.execution_options(populate_existing=True)).all()
    if len(profiles) != 1:
        raise _workspace_unavailable()
    return profiles[0]


def _ready_logo(
    db: Session,
    file_id: UUID,
    *,
    lock: bool = False,
    shared_lock: bool = False,
    allow_archived: bool = False,
) -> File:
    statement = select(File).where(File.id == file_id)
    if lock:
        statement = statement.with_for_update(read=shared_lock, nowait=not shared_lock)
    file = db.scalar(statement.execution_options(populate_existing=True))
    if not isinstance(file, File):
        raise _logo_not_ready()
    if (
        file.purpose != "workspace_logo"
        or (file.is_deleted and not allow_archived)
        or file.state != "ready"
        or file.actual_size is None
        or not file.digest
        or file.operation_id is not None
    ):
        raise _logo_not_ready()
    return file


@router.get("/appearance", response_model=WorkspaceAppearanceResponse)
def get_workspace_appearance(
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> WorkspaceAppearanceResponse:
    response.headers["Cache-Control"] = "no-store"
    try:
        # Signed out there is no organization. An install with one organization shows
        # its theme; otherwise the default theme (owner checkpoint after S07).
        profiles = db.scalars(
            select(WorkspaceProfile).where(WorkspaceProfile.is_deleted.is_(False)).limit(2)
        ).all()
    except SQLAlchemyError as error:
        db.rollback()
        raise _workspace_unavailable() from error
    theme = profiles[0].theme if len(profiles) == 1 else "slate"
    return WorkspaceAppearanceResponse.model_validate({"theme": theme})


@router.get("", response_model=WorkspaceResponse | WorkspaceGuestResponse)
def get_workspace(
    actor: WorkspaceReadUser,
    db: Annotated[Session, Depends(get_db)],
) -> WorkspaceResponse | WorkspaceGuestResponse:
    profile = _workspace(db)
    if require_current_membership(db, actor).role == "guest":
        return WorkspaceGuestResponse.model_validate(profile)
    return WorkspaceResponse.model_validate(profile)


@router.patch("", response_model=WorkspaceResponse)
def update_workspace(
    payload: WorkspaceUpdate,
    actor: WorkspaceReadUser,
    db: Annotated[Session, Depends(get_db)],
) -> WorkspaceResponse:
    logo_supplied = "logo_file_id" in payload.model_fields_set
    with transfer_slot() if logo_supplied else nullcontext():
        return _save_workspace(payload, actor.id, db, logo_supplied)


def _save_workspace(
    payload: WorkspaceUpdate, actor_id: UUID, db: Session, logo_supplied: bool
) -> WorkspaceResponse:
    claim: DeletionClaim | None = None
    try:
        if logo_supplied:
            lock_quota(db)
        require_fresh_exact_admin(db, actor_id)
        profile = _workspace(db, lock=True, nowait=logo_supplied)
        if payload.revision != profile.revision:
            raise _stale_revision()
        if logo_supplied:
            old_id = profile.logo_file_id
            identities = {
                identity for identity in (old_id, payload.logo_file_id) if identity is not None
            }
            logos = {
                identity: _ready_logo(
                    db,
                    identity,
                    lock=True,
                    allow_archived=identity == old_id and identity != payload.logo_file_id,
                )
                for identity in sorted(identities)
            }
            if old_id is not None and old_id != payload.logo_file_id:
                claim = claim_logo_replacement(db, logos[old_id], actor_id)
        for field in payload.model_fields_set - {"revision"}:
            setattr(profile, field, getattr(payload, field))
        profile.revision += 1
        profile.performed_by = actor_id
        db.flush()
        acknowledgment = WorkspaceResponse.model_validate(profile)
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        raise _workspace_unavailable() from exc
    except HTTPException:
        db.rollback()
        raise
    if claim is not None:
        try:
            delete_and_finalize(db, claim, get_storage())
            # The detached receipt contains only values captured at admission.
            return acknowledgment
        except (ProviderUnavailable, HTTPException, SQLAlchemyError) as exc:
            db.rollback()
            raise HTTPException(
                503,
                detail={
                    "code": "workspace_logo_cleanup_partial",
                    "message": (
                        "Workspace settings were saved; old logo cleanup requires reconciliation"
                    ),
                },
                headers={"Cache-Control": "no-store"},
            ) from exc
    return acknowledgment


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
