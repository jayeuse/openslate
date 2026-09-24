"""Contextual Event and Announcement file access; never expose Board bytes by bare ID."""

from hashlib import sha256
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.common.dependencies import require_capability
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.access.users.permissions import Capability
from app.systems.boards.attachment_service import (
    attachment_files,
    link_file,
    unlink_file,
    visible_file,
)
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import (
    SecurityEventPersistenceError,
    append_committed_security_event,
)
from app.systems.platform.files.access import error, fresh_user
from app.systems.platform.files.providers import (
    ProviderUnavailable,
    StorageBackend,
    hold_file_worker,
)
from app.systems.platform.files.schemas import FileResponse
from app.systems.platform.files.storage import get_storage


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(
    prefix="/boards", tags=["board attachments"], dependencies=[Depends(_private_cache)]
)
Reader = Annotated[User, Depends(require_capability(Capability.RECORDS_READ))]
Writer = Annotated[User, Depends(require_capability(Capability.RECORDS_WRITE))]
Database = Annotated[Session, Depends(get_db)]
Store = Annotated[StorageBackend, Depends(get_storage)]


class AttachmentLink(BaseModel):
    model_config = ConfigDict(extra="forbid")
    file_id: UUID
    board_revision: int = Field(ge=1)
    content_revision: int = Field(ge=1)


class AttachmentRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    board_revision: int = Field(ge=1)
    content_revision: int = Field(ge=1)


class AttachmentList(BaseModel):
    items: list[FileResponse]
    limit: int
    offset: int
    has_more: bool


def _list(
    db: Session,
    actor: User,
    board_id: UUID,
    kind: str,
    content_id: UUID,
    *,
    view: str,
    limit: int,
    offset: int,
) -> AttachmentList:
    items = attachment_files(
        db,
        fresh_user(db, actor.id),
        board_id,
        kind,
        content_id,
        view=view,
        limit=limit + 1,
        offset=offset,
    )
    return AttachmentList(
        items=[FileResponse.model_validate(item) for item in items[:limit]],
        limit=limit,
        offset=offset,
        has_more=len(items) > limit,
    )


def _download(
    request: Request,
    db: Session,
    actor: User,
    board_id: UUID,
    kind: str,
    content_id: UUID,
    file_id: UUID,
    view: str,
    storage: StorageBackend,
) -> Response:
    with hold_file_worker(request):
        file = visible_file(
            db, fresh_user(db, actor.id), board_id, kind, content_id, file_id, view=view
        )
        key, digest, size = file.object_key, file.digest, file.actual_size
        filename, media_type = file.filename, file.media_type or "application/octet-stream"
        db.commit()
        try:
            content = storage.download(key)
        except ProviderUnavailable as exc:
            raise error("storage_unavailable", "File content is unavailable", 503) from exc
        if content is None or sha256(content).hexdigest() != digest or len(content) != size:
            raise error("file_integrity_error", "File content is unavailable", 503)
        db.expire_all()
        current = visible_file(
            db, fresh_user(db, actor.id), board_id, kind, content_id, file_id, view=view
        )
        if current.object_key != key or current.digest != digest or current.actual_size != size:
            raise error("file_not_found", "File not found", 404)
        db.commit()
        try:
            append_committed_security_event(
                SecurityEventIngestRequest(
                    event_type="file.download",
                    outcome=SecurityEventOutcome.ATTEMPT,
                    source="board_attachments",
                    operation_id=uuid4(),
                    actor_id=actor.id,
                    metadata={"file_id": str(file_id)},
                )
            )
        except SecurityEventPersistenceError as exc:
            raise error("file_event_unavailable", "Unable to record file access", 503) from exc
        return Response(
            content,
            media_type=media_type,
            headers={
                "Content-Disposition": "attachment; filename*=UTF-8''" + quote(filename, safe=""),
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )


@router.get("/{board_id}/events/{event_id}/attachments", response_model=AttachmentList)
def list_event_attachments(
    board_id: UUID,
    event_id: UUID,
    actor: Reader,
    db: Database,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AttachmentList:
    return _list(db, actor, board_id, "event", event_id, view="current", limit=limit, offset=offset)


@router.post("/{board_id}/events/{event_id}/attachments", response_model=FileResponse)
def attach_event_file(
    board_id: UUID, event_id: UUID, payload: AttachmentLink, actor: Writer, db: Database
) -> FileResponse:
    return FileResponse.model_validate(
        link_file(
            db,
            fresh_user(db, actor.id),
            board_id,
            "event",
            event_id,
            payload.file_id,
            board_revision=payload.board_revision,
            content_revision=payload.content_revision,
        )
    )


@router.delete("/{board_id}/events/{event_id}/attachments/{file_id}", status_code=204)
def detach_event_file(
    board_id: UUID,
    event_id: UUID,
    file_id: UUID,
    payload: AttachmentRevision,
    actor: Writer,
    db: Database,
) -> None:
    unlink_file(
        db,
        fresh_user(db, actor.id),
        board_id,
        "event",
        event_id,
        file_id,
        board_revision=payload.board_revision,
        content_revision=payload.content_revision,
    )


@router.get("/{board_id}/events/{event_id}/attachments/{file_id}/content")
def download_event_file(
    request: Request,
    board_id: UUID,
    event_id: UUID,
    file_id: UUID,
    actor: Reader,
    db: Database,
    storage: Store,
) -> Response:
    return _download(request, db, actor, board_id, "event", event_id, file_id, "current", storage)


@router.get(
    "/{board_id}/announcements/{announcement_id}/attachments", response_model=AttachmentList
)
def list_announcement_attachments(
    board_id: UUID,
    announcement_id: UUID,
    actor: Reader,
    db: Database,
    view: Literal["published", "draft"] = "published",
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AttachmentList:
    return _list(
        db, actor, board_id, "announcement", announcement_id, view=view, limit=limit, offset=offset
    )


@router.post("/{board_id}/announcements/{announcement_id}/attachments", response_model=FileResponse)
def attach_announcement_file(
    board_id: UUID,
    announcement_id: UUID,
    payload: AttachmentLink,
    actor: Writer,
    db: Database,
) -> FileResponse:
    return FileResponse.model_validate(
        link_file(
            db,
            fresh_user(db, actor.id),
            board_id,
            "announcement",
            announcement_id,
            payload.file_id,
            board_revision=payload.board_revision,
            content_revision=payload.content_revision,
        )
    )


@router.delete("/{board_id}/announcements/{announcement_id}/attachments/{file_id}", status_code=204)
def detach_announcement_file(
    board_id: UUID,
    announcement_id: UUID,
    file_id: UUID,
    payload: AttachmentRevision,
    actor: Writer,
    db: Database,
) -> None:
    unlink_file(
        db,
        fresh_user(db, actor.id),
        board_id,
        "announcement",
        announcement_id,
        file_id,
        board_revision=payload.board_revision,
        content_revision=payload.content_revision,
    )


@router.get("/{board_id}/announcements/{announcement_id}/attachments/{file_id}/content")
def download_announcement_file(
    request: Request,
    board_id: UUID,
    announcement_id: UUID,
    file_id: UUID,
    actor: Reader,
    db: Database,
    storage: Store,
    view: Literal["published", "draft"] = "published",
) -> Response:
    return _download(
        request, db, actor, board_id, "announcement", announcement_id, file_id, view, storage
    )
