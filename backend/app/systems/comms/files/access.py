"""Comms parent admission for the existing platform file transfer lifecycle."""

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.users.models import User
from app.systems.comms.access import require_conversation_access
from app.systems.comms.capabilities import capability_check
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.messages.admission import file_shape, posting_context
from app.systems.platform.files.access import error
from app.systems.platform.files.models import File


def parent(
    db: Session,
    conversation_id: UUID,
    *,
    active: bool,
    lock: bool = False,
    shared_lock: bool = False,
) -> CommsConversation:
    query = (
        select(CommsConversation)
        .where(
            CommsConversation.org_id == bound_organization_column(),
            CommsConversation.id == conversation_id,
            CommsConversation.is_deleted.is_(False),
            CommsConversation.deleted_at.is_(None),
        )
        .execution_options(populate_existing=True)
    )
    row = db.scalar(query.with_for_update(nowait=True, read=shared_lock) if lock else query)
    if row is None:
        raise error("file_not_found", "File parent not found", 404)
    if active and row.archived_at is not None:
        raise error("file_parent_closed", "File parent is not active")
    return row


def authorize_parent(
    db: Session,
    user: User,
    conversation_id: UUID,
    *,
    write: bool,
    filename: str = "",
    size: int = 0,
) -> None:
    try:
        require_conversation_access(db, user, conversation_id, "read")
        if write:
            _, _, settings = posting_context(db, user, conversation_id)
            if not capability_check(db, user, conversation_id)["capabilities"]["attachFiles"][
                "allowed"
            ]:
                raise error("comms_capability_denied", "Capability required", 403)
            file_shape(filename, size, settings)
    except HTTPException as exc:
        if exc.status_code == 404:
            raise error("file_not_found", "File not found", 404) from exc
        exc.headers = {**(exc.headers or {}), "Cache-Control": "no-store"}
        raise


def authorize_file(
    db: Session, user: User, file: File, conversation_id: UUID, *, write: bool
) -> None:
    if (
        file.purpose != "comms_attachment"
        or file.conversation_id != conversation_id
        or file.is_deleted
    ):
        raise error("file_not_found", "File not found", 404)
    authorize_parent(
        db, user, conversation_id, write=write, filename=file.filename, size=file.expected_size
    )
    if write and file.creator_id != user.id:
        raise error("comms_capability_denied", "Only the uploader can upload this file", 403)
