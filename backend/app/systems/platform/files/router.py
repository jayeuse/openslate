from typing import Annotated, Any, cast
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user
from app.common.listing import ListQuerySpec, execute_standard_list
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.platform.files import service
from app.systems.platform.files.access import authorize, error, load, parent
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import StorageBackend, hold_file_worker
from app.systems.platform.files.schemas import (
    FileCreate,
    FileListRequest,
    FileListResponse,
    FileResponse,
    FileSortField,
)
from app.systems.platform.files.storage import get_storage

router = APIRouter(prefix="/files", tags=["files"])
DB = Annotated[Session, Depends(get_db)]
Actor = Annotated[User, Depends(get_current_user)]
Store = Annotated[StorageBackend, Depends(get_storage)]
SPEC = ListQuerySpec(
    sort_fields={
        FileSortField.CREATED_AT: cast(ColumnElement[Any], File.created_at),
        FileSortField.UPDATED_AT: cast(ColumnElement[Any], File.updated_at),
    },
    default_sort=FileSortField.CREATED_AT,
    tie_breaker=cast(ColumnElement[Any], File.id),
    deleted_field=cast(ColumnElement[bool], File.is_deleted),
)


@router.post("", response_model=FileResponse, status_code=201)
def create_file(payload: FileCreate, user: Actor, db: DB) -> FileResponse:
    return service.reserve(db, user, payload)


@router.get("", response_model=FileListResponse)
def list_files(
    params: Annotated[FileListRequest, Query()], user: Actor, db: DB
) -> FileListResponse:
    authorize(db, user, params.purpose, record_id=params.record_id)
    if (params.purpose == "record_attachment") != (params.record_id is not None):
        raise error("file_parent_required", "Only attachment lists require a record", 422)
    parent(db, params.record_id, active=False)
    statement = select(File).where(File.purpose == params.purpose)
    if params.record_id is not None:
        statement = statement.where(File.record_id == params.record_id)
    result = execute_standard_list(db, statement, params, SPEC)
    return FileListResponse.model_validate({"items": result.items, "pagination": result.pagination})


@router.get("/{file_id}", response_model=FileResponse)
def get_file(file_id: UUID, user: Actor, db: DB) -> FileResponse:
    file = load(db, file_id)
    authorize(db, user, file.purpose, record_id=file.record_id)
    return FileResponse.model_validate(file)


@router.put("/{file_id}/content", response_model=FileResponse)
def upload_file(
    request: Request,
    file_id: UUID,
    user: Actor,
    db: DB,
    storage: Store,
    content: Annotated[bytes, Body(media_type="application/octet-stream")],
) -> FileResponse:
    with hold_file_worker(request):
        return service.upload(db, user.id, file_id, content, storage)


@router.get("/{file_id}/content")
def download_file(request: Request, file_id: UUID, user: Actor, db: DB, storage: Store) -> Response:
    with hold_file_worker(request):
        content, media_type, filename = service.download(db, user.id, file_id, storage)
        return Response(
            content,
            media_type=media_type,
            headers={
                "Content-Disposition": "attachment; filename*=UTF-8''" + quote(filename, safe=""),
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )


@router.post("/{file_id}/archive", response_model=FileResponse)
def archive_file(file_id: UUID, user: Actor, db: DB) -> FileResponse:
    return service.archive(db, user.id, file_id)


@router.post("/{file_id}/reopen", response_model=FileResponse)
def reopen_file(file_id: UUID, user: Actor, db: DB) -> FileResponse:
    return service.archive(db, user.id, file_id, reopen=True)


@router.post("/{file_id}/reconcile", response_model=FileResponse)
def reconcile_file(
    request: Request, file_id: UUID, user: Actor, db: DB, storage: Store
) -> FileResponse:
    with hold_file_worker(request):
        return service.reconcile(db, user.id, file_id, storage)
