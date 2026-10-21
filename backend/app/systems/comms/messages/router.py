"""The eight S17 message routes; configuration, revision reads and S18 remain separate."""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query, Response
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.core.database.session import AuditSession, get_db
from app.systems.access.users.models import User
from app.systems.comms.access import (
    error,
    require_conversation_access,
)
from app.systems.comms.capabilities import capability_check
from app.systems.comms.messages.admission import mentions as _mentions
from app.systems.comms.messages.admission import posting_context as _posting_context
from app.systems.comms.messages.bootstrap import bootstrap
from app.systems.comms.messages.commands import send
from app.systems.comms.messages.interaction_models import CommsMention
from app.systems.comms.messages.link_models import CommsMessageAttachment, CommsMessageRecordLink
from app.systems.comms.messages.models import (
    CommsMessage,
    CommsMessageRevision,
    CommsReadState,
)
from app.systems.comms.messages.mutations import advance_generation, lock_counter, message_version
from app.systems.comms.messages.reads import get_message, history, project_messages
from app.systems.comms.messages.schemas import (
    BootstrapResponse,
    EditRequest,
    HistoryRequest,
    HistoryResponse,
    LiveMessage,
    MessageResponse,
    ReadRequest,
    ReadResponse,
    SendRequest,
    Tombstone,
)
from app.systems.comms.messages.service import MAX_SEQUENCE
from app.systems.comms.realtime.events import message_event, user_event
from app.systems.comms.settings.models import CommsMemberPreferences

VERSION_HEADERS = {
    "ETag": {"description": "Opaque response validator", "schema": {"type": "string"}}
}
VERSION_RESPONSE: dict[int | str, dict[str, Any]] = {200: {"headers": VERSION_HEADERS}}
router = APIRouter(
    prefix="/comms",
    tags=["comms"],
    dependencies=[Depends(get_current_membership)],
    responses={
        429: {
            "description": "Send or slow-mode limit",
            "headers": {
                "Retry-After": {"schema": {"type": "integer", "minimum": 1}},
            },
        },
        403: {"description": "Current operation is not permitted"},
        404: {"description": "Absent or unreadable resource"},
        503: {"description": "Message operation unavailable"},
    },
)
DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]


def _private(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


def _version(response: Response, message: LiveMessage | Tombstone) -> LiveMessage | Tombstone:
    _private(response)
    response.headers["ETag"] = message_version(message)
    return message


@router.get("/bootstrap", response_model=BootstrapResponse)
def get_bootstrap(db: DB, user: Actor, response: Response) -> BootstrapResponse:
    _private(response)
    return bootstrap(db, user)


@router.get("/conversations/{conversation_id}/messages", response_model=HistoryResponse)
def get_history(
    conversation_id: UUID,
    request: Annotated[HistoryRequest, Query()],
    db: DB,
    user: Actor,
    response: Response,
) -> HistoryResponse:
    require_conversation_access(db, user, conversation_id, "read")
    _private(response)
    return history(db, user.id, conversation_id, request)


@router.get(
    "/conversations/{conversation_id}/messages/by-sequence/{seq}",
    response_model=MessageResponse,
    responses=VERSION_RESPONSE,
)
def get_by_sequence(
    conversation_id: UUID,
    seq: Annotated[int, Path(ge=1, le=MAX_SEQUENCE)],
    db: DB,
    user: Actor,
    response: Response,
) -> LiveMessage | Tombstone:
    require_conversation_access(db, user, conversation_id, "read")
    message = get_message(db, conversation_id, seq=seq)
    return _version(response, project_messages(db, user.id, [message])[0])


@router.get(
    "/conversations/{conversation_id}/messages/{message_id}",
    response_model=MessageResponse,
    responses=VERSION_RESPONSE,
)
def get_one(
    conversation_id: UUID,
    message_id: UUID,
    db: DB,
    user: Actor,
    response: Response,
) -> LiveMessage | Tombstone:
    require_conversation_access(db, user, conversation_id, "read")
    message = get_message(db, conversation_id, message_id=message_id)
    return _version(response, project_messages(db, user.id, [message])[0])


@router.post(
    "/conversations/{conversation_id}/messages",
    status_code=201,
    response_model=MessageResponse,
    responses={
        200: {"model": MessageResponse, "headers": VERSION_HEADERS},
        201: {
            "headers": {
                **VERSION_HEADERS,
                "Location": {"schema": {"type": "string"}},
            }
        },
        409: {"description": "Client key identifies a different original send"},
    },
)
def create_message(
    conversation_id: UUID,
    request: SendRequest,
    db: DB,
    user: Actor,
    response: Response,
) -> LiveMessage | Tombstone:
    message, replayed = send(db, user, conversation_id, request)
    response.status_code = 200 if replayed else 201
    if not replayed:
        response.headers["Location"] = (
            f"/api/comms/conversations/{conversation_id}/messages/{message.id}"
        )
    return _version(response, message)


def _change_message(
    db: AuditSession,
    user: User,
    conversation_id: UUID,
    message_id: UUID,
    request: EditRequest | None,
) -> CommsMessage:
    require_conversation_access(db, user, conversation_id, "read")
    lock_counter(db, conversation_id)
    _, check, settings = _posting_context(db, user, conversation_id)
    message = get_message(db, conversation_id, message_id=message_id, lock=True)
    if message.is_deleted or message.deleted_at:
        raise error("comms_not_found", "Message not found")
    own = message.author_id == user.id
    if request is not None and not own:
        raise error("comms_post_denied", "Only the author may edit a message", 403)
    if not own or check["conversation_level"] == "read":
        capabilities = capability_check(db, user, conversation_id)["capabilities"]
        if not own and not capabilities["deleteOthersMessages"]["allowed"]:
            raise error("comms_capability_denied", "Capability required", 403)
        if own and not capabilities["reply"]["allowed"]:
            raise error("comms_post_denied", "Message changes are not allowed", 403)
    minutes = settings["edit_window_minutes" if request is not None else "delete_window_minutes"]
    if own and minutes and (utc_now() - message.created_at).total_seconds() > minutes * 60:
        raise error("comms_post_denied", "Message change window has ended", 403)
    if request is not None:
        if not request.body.strip() and not any(
            db.scalar(
                select(model.id)
                .where(
                    model.org_id == bound_organization_column(),
                    model.message_id == message_id,
                    model.is_deleted.is_(False),
                )
                .limit(1)
            )
            for model in (CommsMessageAttachment, CommsMessageRecordLink)
        ):
            raise error("comms_message_empty", "Message is empty", 422)
        _mentions(db, user, conversation_id, request, settings)
        db.add(
            CommsMessageRevision(
                org_id=message.org_id, message_id=message.id, author_id=user.id, body=message.body
            )
        )
        for mention in db.scalars(
            select(CommsMention).where(
                CommsMention.org_id == bound_organization_column(),
                CommsMention.message_id == message.id,
            )
        ):
            db.delete(mention)
        db.flush()
        for person in request.mention_user_ids:
            db.add(CommsMention(org_id=message.org_id, message_id=message.id, user_id=person))
        message.body, message.edited_at = request.body, utc_now()
        message.mentions_channel, message.mentions_here = (
            request.mentions_channel,
            request.mentions_here,
        )
    else:
        message.is_deleted, message.deleted_at, message.deleted_by = True, utc_now(), user.id
    advance_generation(message)
    from app.systems.comms.previews.jobs import stage_preview

    stage_preview(db, message)
    message_event(db, conversation_id, message.seq, "edited" if request is not None else "deleted")
    db.commit()
    db.refresh(message)
    return message


@router.patch(
    "/conversations/{conversation_id}/messages/{message_id}",
    response_model=LiveMessage,
    responses=VERSION_RESPONSE,
)
def edit_message(
    conversation_id: UUID,
    message_id: UUID,
    request: EditRequest,
    db: DB,
    user: Actor,
    response: Response,
) -> LiveMessage | Tombstone:
    try:
        message = _change_message(db, user, conversation_id, message_id, request)
        return _version(response, project_messages(db, user.id, [message])[0])
    except SQLAlchemyError as exc:
        db.rollback()
        raise error("comms_unavailable", "Message unavailable", 503) from exc


@router.delete(
    "/conversations/{conversation_id}/messages/{message_id}",
    response_model=Tombstone,
    responses=VERSION_RESPONSE,
)
def delete_message(
    conversation_id: UUID,
    message_id: UUID,
    db: DB,
    user: Actor,
    response: Response,
) -> LiveMessage | Tombstone:
    try:
        message = _change_message(db, user, conversation_id, message_id, None)
        return _version(response, project_messages(db, user.id, [message])[0])
    except SQLAlchemyError as exc:
        db.rollback()
        raise error("comms_unavailable", "Message unavailable", 503) from exc


@router.put("/conversations/{conversation_id}/read", response_model=ReadResponse)
def mark_read(
    conversation_id: UUID,
    request: ReadRequest,
    db: DB,
    user: Actor,
    response: Response,
) -> ReadResponse:
    require_conversation_access(db, user, conversation_id, "read")
    try:
        counter = lock_counter(db, conversation_id)
        require_conversation_access(db, user, conversation_id, "read")
        row = db.scalar(
            select(CommsReadState)
            .where(
                CommsReadState.org_id == bound_organization_column(),
                CommsReadState.conversation_id == conversation_id,
                CommsReadState.user_id == user.id,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        watermark = min(request.last_read_seq, counter.last_seq)
        changed = row is None or (row is not None and watermark > row.last_read_seq)
        if row is None:
            row = CommsReadState(
                org_id=counter.org_id,
                conversation_id=conversation_id,
                user_id=user.id,
                last_read_seq=watermark,
            )
            db.add(row)
        else:
            row.last_read_seq = max(row.last_read_seq, watermark)
        pref = db.scalar(
            select(CommsMemberPreferences)
            .where(
                CommsMemberPreferences.org_id == bound_organization_column(),
                CommsMemberPreferences.conversation_id == conversation_id,
                CommsMemberPreferences.user_id == user.id,
                CommsMemberPreferences.is_deleted.is_(False),
            )
            .with_for_update()
        )
        if pref is not None:
            changed = changed or bool(pref.manual_unread)
            pref.manual_unread = False
        result = ReadResponse(conversation_id=conversation_id, last_read_seq=row.last_read_seq)
        if changed:
            user_event(db, user.id, "read", result.model_dump(mode="json"))
        db.commit()
        _private(response)
        return result
    except SQLAlchemyError as exc:
        db.rollback()
        raise error("comms_unavailable", "Read state unavailable", 503) from exc
