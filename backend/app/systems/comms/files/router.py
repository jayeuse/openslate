"""The three S18 binary endpoints reuse platform validation, capacity and private Storage."""

from datetime import UTC, datetime
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Request, Response
from pydantic import ConfigDict

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.core.database.session import AuditSession, get_db
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import User
from app.systems.comms.files.access import authorize_file, authorize_parent, parent
from app.systems.comms.messages.schemas import WireModel
from app.systems.comms.settings.resolution import Scope, resolve_settings
from app.systems.platform.files import service
from app.systems.platform.files.access import error, fresh_user, load
from app.systems.platform.files.delivery import read_content, record_download
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import StorageBackend, hold_file_worker
from app.systems.platform.files.quota import lock_quota, require_capacity
from app.systems.platform.files.schemas import BoardFileCreate, FileState
from app.systems.platform.files.storage import get_storage


class CommsFile(WireModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    org_id: UUID
    conversation_id: UUID
    creator_id: UUID
    purpose: Literal["comms_attachment"]
    filename: str
    expected_size: int
    actual_size: int | None
    media_type: str | None
    state: FileState
    failure_code: str | None
    is_deleted: bool
    created_at: datetime
    updated_at: datetime


def _private(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(
    prefix="/comms/conversations",
    tags=["comms"],
    dependencies=[Depends(get_current_membership), Depends(_private)],
)
DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]
Store = Annotated[StorageBackend, Depends(get_storage)]


@router.post(
    "/{conversation_id}/files",
    response_model=CommsFile,
    status_code=201,
    responses={201: {"headers": {"Location": {"schema": {"type": "string"}}}}},
)
def reserve(
    conversation_id: UUID, payload: BoardFileCreate, db: DB, actor: Actor, response: Response
) -> CommsFile:
    authorize_parent(
        db,
        actor,
        conversation_id,
        write=True,
        filename=payload.filename,
        size=payload.expected_size,
    )
    service.expire_unused_reservations(db, datetime.now(UTC))
    lock_quota(db)
    parent(db, conversation_id, active=True, lock=True)
    authorize_parent(
        db,
        fresh_user(db, actor.id),
        conversation_id,
        write=True,
        filename=payload.filename,
        size=payload.expected_size,
    )
    require_capacity(db, "comms_attachment", payload.expected_size, creator_id=actor.id)
    org = bound_organization(db)
    row = File(
        org_id=org,
        purpose="comms_attachment",
        conversation_id=conversation_id,
        creator_id=actor.id,
        filename=payload.filename,
        expected_size=payload.expected_size,
        object_key=service.object_key(org_id=org, user_id=actor.id),
        state="awaiting_upload",
    )
    db.add(row)
    db.commit()
    response.headers["Location"] = f"/api/comms/conversations/{conversation_id}/files/{row.id}"
    return CommsFile.model_validate(row)


@router.put("/{conversation_id}/files/{file_id}/content", response_model=CommsFile)
def upload(
    request: Request,
    conversation_id: UUID,
    file_id: UUID,
    db: DB,
    actor: Actor,
    storage: Store,
    content: Annotated[bytes, Body(media_type="application/octet-stream")],
) -> CommsFile:
    authorize_parent(db, actor, conversation_id, write=False)
    authorize_file(db, actor, load(db, file_id), conversation_id, write=True)
    with hold_file_worker(request):
        service.upload(db, actor.id, file_id, content, storage, conversation_id=conversation_id)
    return CommsFile.model_validate(load(db, file_id))


def _downloadable(db: AuditSession, actor_id: UUID, conversation_id: UUID, file_id: UUID) -> File:
    actor = fresh_user(db, actor_id)
    authorize_parent(db, actor, conversation_id, write=False)
    candidate = load(db, file_id)
    authorize_file(db, actor, candidate, conversation_id, write=False)
    conversation = parent(db, conversation_id, active=False, lock=True, shared_lock=True)
    scope: Scope = (
        {"kind": "channel", "id": conversation_id}
        if conversation.kind == "channel"
        else {"kind": "workspace"}
    )
    if not resolve_settings(db, scope)["effective"]["file_downloads"]:
        raise error("comms_capability_denied", "File downloads are disabled", 403)
    file = load(db, file_id, lock=True, shared_lock=True)
    authorize_file(db, fresh_user(db, actor_id), file, conversation_id, write=False)
    if file.state != "ready":
        raise error("file_not_found", "File not found", 404)
    return file


@router.get(
    "/{conversation_id}/files/{file_id}/content",
    response_class=Response,
    responses={
        200: {
            "description": "Private file bytes with attachment disposition and nosniff",
            "content": {
                "application/octet-stream": {"schema": {"type": "string", "format": "binary"}}
            },
            "headers": {
                "Content-Disposition": {"schema": {"type": "string"}},
                "X-Content-Type-Options": {"schema": {"type": "string"}},
            },
        },
    },
)
def download(
    request: Request, conversation_id: UUID, file_id: UUID, db: DB, actor: Actor, storage: Store
) -> Response:
    with hold_file_worker(request):
        file = _downloadable(db, actor.id, conversation_id, file_id)
        content, media_type, filename = read_content(db, file, storage)
        file = _downloadable(db, actor.id, conversation_id, file_id)
        org = file.org_id
        db.commit()
        record_download(actor.id, file_id, org_id=org)
        return Response(
            content,
            media_type=media_type,
            headers={
                "Content-Disposition": "attachment; filename*=UTF-8''" + quote(filename, safe=""),
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "private, no-store",
            },
        )
