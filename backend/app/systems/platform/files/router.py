from typing import Annotated, Any, cast
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Query, Request, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user
from app.common.listing import ListQuerySpec, execute_standard_list
from app.core.database import get_db
from app.systems.access.identity.eligibility import identity_eligible_clause
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import Membership, User
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
    LibraryFileListResponse,
    LibraryFileSortField,
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
LIBRARY_SPEC = ListQuerySpec(
    sort_fields={
        LibraryFileSortField.CREATED_AT: cast(ColumnElement[Any], File.created_at),
        LibraryFileSortField.UPDATED_AT: cast(ColumnElement[Any], File.updated_at),
        LibraryFileSortField.NAME: cast(ColumnElement[Any], File.filename),
        LibraryFileSortField.SIZE: cast(
            ColumnElement[Any], func.coalesce(File.actual_size, File.expected_size)
        ),
    },
    default_sort=LibraryFileSortField.CREATED_AT,
    tie_breaker=cast(ColumnElement[Any], File.id),
    deleted_field=cast(ColumnElement[bool], File.is_deleted),
    search_fields=(cast(ColumnElement[str], File.filename),),
)


@router.post("", response_model=FileResponse, status_code=201)
def create_file(payload: FileCreate, user: Actor, db: DB) -> FileResponse:
    return service.reserve(db, user, payload)


@router.get("", response_model=LibraryFileListResponse | FileListResponse)
def list_files(
    params: Annotated[FileListRequest, Query()], user: Actor, db: DB, response: Response
) -> LibraryFileListResponse | FileListResponse:
    authorize(
        db, user, params.purpose, record_id=params.record_id, department_id=params.department_id
    )
    if (params.purpose == "record_attachment") != (params.record_id is not None):
        raise error("file_parent_required", "Only attachment lists require a record", 422)
    library = params.purpose == "library_document"
    if library != (params.department_id is not None):
        raise error("file_parent_required", "Only library lists require a department", 422)
    if not library and params.sort_by is not None and params.sort_by.value not in FileSortField:
        raise error("file_sort_invalid", "This file purpose does not support this sort", 422)
    parent(db, params.record_id, active=False, department_id=params.department_id)
    statement = select(File).where(File.purpose == params.purpose)
    if params.purpose == "user_avatar":
        response.headers["Cache-Control"] = "private, no-store"
        statement = statement.where(File.creator_id == user.id)
    if params.record_id is not None:
        statement = statement.where(File.record_id == params.record_id)
    if library:
        statement = statement.where(File.department_id == params.department_id)
    # The generic-purpose allowlist above keeps the existing Board/Record specification.
    spec = LIBRARY_SPEC if library else cast(ListQuerySpec[LibraryFileSortField], SPEC)
    result = execute_standard_list(db, statement, params, spec)
    if library:
        response.headers["Cache-Control"] = "private, no-store"
        creator_ids = {file.creator_id for file in result.items}
        labels = (
            {
                creator_id: display_name or username
                for creator_id, display_name, username in (
                    db.execute(
                        select(User.id, User.display_name, User.username)
                        .join(Membership, Membership.user_id == User.id).where(
                            User.id.in_(creator_ids),
                            Membership.org_id == bound_organization(db),
                            User.status == "active",
                            established_user_clause(),
                            identity_eligible_clause(),
                        )
                    ).tuples()
                )
            }
            if creator_ids
            else {}
        )
        usage = db.scalar(
            select(func.coalesce(func.sum(File.actual_size), 0)).where(
                File.purpose == "library_document",
                File.department_id == params.department_id,
                File.state == "ready",
            )
        )
        return LibraryFileListResponse.model_validate(
            {
                "items": result.items,
                "pagination": result.pagination,
                "creator_labels": labels,
                "storage_used_bytes": usage,
            }
        )
    return FileListResponse.model_validate({"items": result.items, "pagination": result.pagination})


@router.get("/{file_id}", response_model=FileResponse)
def get_file(file_id: UUID, user: Actor, db: DB) -> FileResponse:
    file = load(db, file_id)
    authorize(
        db,
        user,
        file.purpose,
        record_id=file.record_id,
        department_id=file.department_id,
        creator_id=file.creator_id,
    )
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
