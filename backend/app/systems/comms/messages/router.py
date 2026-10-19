"""The eight S17 message routes; configuration, revision reads and S18 remain separate."""

from datetime import datetime
from hashlib import sha256
from math import ceil
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query, Response
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.core.database.session import AuditSession, get_db
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import User
from app.systems.comms.access import (
    LEVELS,
    _conversation_access_statement,
    conversation_reader_statement,
    error,
    require_conversation_access,
)
from app.systems.comms.capabilities import capability_check
from app.systems.comms.conversations.models import CommsConversation, CommsMember
from app.systems.comms.messages.bootstrap import bootstrap
from app.systems.comms.messages.interaction_models import CommsMention
from app.systems.comms.messages.models import (
    CommsConversationCounter,
    CommsMessage,
    CommsMessageRevision,
    CommsReadState,
)
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
from app.systems.comms.messages.service import (
    MAX_SEQUENCE,
    InvalidSend,
    SendConflict,
    SendMessageCommand,
    SendRateLimited,
    send_message,
)
from app.systems.comms.settings.models import CommsMemberPreferences
from app.systems.comms.settings.resolution import Scope, resolve_settings

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
    response.headers["ETag"] = '"' + sha256(message.model_dump_json().encode()).hexdigest() + '"'
    return message


def _counter(db: AuditSession, conversation_id: UUID) -> CommsConversationCounter:
    row = db.scalar(
        select(CommsConversationCounter)
        .where(
            CommsConversationCounter.org_id == bound_organization_column(),
            CommsConversationCounter.conversation_id == conversation_id,
            CommsConversationCounter.is_deleted.is_(False),
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise error("comms_not_found", "Conversation not found")
    return row


def _posting_context(
    db: AuditSession,
    user: User,
    conversation_id: UUID,
) -> tuple[CommsConversation, dict[str, Any], dict[str, Any]]:
    policy = _conversation_access_statement(
        select(CommsConversation.id).where(CommsConversation.id == conversation_id),
        [user.id],
    ).subquery()
    row = db.execute(
        select(CommsConversation, policy.c.level, policy.c.role)
        .join(
            policy,
            policy.c.conversation_id == CommsConversation.id,
        )
        .where(CommsConversation.org_id == bound_organization_column(), policy.c.level > 0)
        .execution_options(populate_existing=True)
    ).first()
    if row is None:
        raise error("comms_not_found", "Conversation not found")
    conversation, level, role = row
    check = {"conversation_level": LEVELS[level], "membership_role": role}
    scope: Scope = (
        {"kind": "channel", "id": conversation_id}
        if conversation.kind == "channel"
        else {
            "kind": "workspace",
        }
    )
    settings = resolve_settings(db, scope)["effective"]
    until = settings["restriction_until"]
    restricted = str(user.id) in settings["restricted_person_ids"] and (
        until is None or datetime.fromisoformat(until.replace("Z", "+00:00")) > utc_now()
    )
    if (
        check["membership_role"] == "guest"
        or conversation.archived_at
        or settings["locked"]
        or restricted
    ):
        raise error("comms_post_denied", "Posting is not allowed", 403)
    if conversation.kind == "direct":
        require_conversation_access(db, user, conversation_id, "post")
    return conversation, check, settings


def _mentions(
    db: AuditSession,
    user: User,
    conversation_id: UUID,
    request: SendRequest | EditRequest,
    settings: dict[str, Any],
) -> None:
    if request.mentions_channel or request.mentions_here:
        capabilities = capability_check(db, user, conversation_id)["capabilities"]
        if not capabilities["mentionChannel"]["allowed"]:
            raise error("comms_capability_denied", "Capability required", 403)
    count = len(request.mention_user_ids) + request.mentions_channel + request.mentions_here
    if settings["mention_limit"] and count > settings["mention_limit"]:
        raise error("comms_invalid_input", "Mention limit exceeded", 422)
    ids = set(request.mention_user_ids)
    if ids:
        members = set(
            db.scalars(
                select(CommsMember.user_id).where(
                    CommsMember.org_id == bound_organization_column(),
                    CommsMember.conversation_id == conversation_id,
                    CommsMember.user_id.in_(ids),
                    CommsMember.is_deleted.is_(False),
                    CommsMember.deleted_at.is_(None),
                )
            )
        )
        readable = set(
            db.scalars(
                conversation_reader_statement(
                    select(CommsConversation.id).where(CommsConversation.id == conversation_id),
                    ids,
                )
            )
        )
        if ids != members or ids != readable:
            raise error("comms_invalid_input", "Mention target unavailable", 422)


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
    org_id = bound_organization(db)
    if (
        db.scalar(
            select(CommsConversation.id).where(
                CommsConversation.org_id == bound_organization_column(),
                CommsConversation.id == conversation_id,
                CommsConversation.is_deleted.is_(False),
                CommsConversation.deleted_at.is_(None),
            )
        )
        is None
    ):
        raise error("comms_not_found", "Conversation not found")

    def authorize(replayed: bool) -> None:
        if replayed:
            require_conversation_access(db, user, conversation_id, "read")
            return
        conversation, check, settings = _posting_context(db, user, conversation_id)
        if check["conversation_level"] == "read":
            raise error("comms_post_denied", "Posting is not allowed", 403)
        if conversation.kind == "channel" and (
            settings["mode"] == "thread-first"
            or settings["mode"] == "announcements"
            and check["conversation_level"] != "manage"
        ):
            raise error("comms_post_denied", "Posting is not allowed", 403)
        if settings["require_record_link"]:
            raise error("comms_invalid_input", "A record link is required", 422)
        _mentions(db, user, conversation_id, request, settings)
        if request.reply_to_id is not None:
            quoted = get_message(db, conversation_id, message_id=request.reply_to_id)
            if quoted.is_deleted or quoted.deleted_at:
                raise error("comms_not_found", "Message not found")
        if settings["slow_mode_seconds"]:
            latest = db.scalar(
                select(func.max(CommsMessage.created_at)).where(
                    CommsMessage.org_id == bound_organization_column(),
                    CommsMessage.conversation_id == conversation_id,
                    CommsMessage.author_id == user.id,
                )
            )
            if latest is not None:
                remaining = settings["slow_mode_seconds"] - (utc_now() - latest).total_seconds()
                if remaining > 0:
                    refused = error("comms_slow_mode", "Wait before sending again", 429)
                    refused.headers = {"Retry-After": str(ceil(remaining))}
                    raise refused

    try:
        result = send_message(
            db,
            org_id=org_id,
            author_id=user.id,
            conversation_id=conversation_id,
            command=SendMessageCommand(**request.model_dump()),
            authorize=authorize,
        )
        message = project_messages(db, user.id, [result.message])[0]
        if not result.replayed and not isinstance(message, LiveMessage):
            raise error("comms_unavailable", "Message changed before acknowledgement", 503)
        response.status_code = 200 if result.replayed else 201
        if not result.replayed:
            response.headers["Location"] = (
                f"/api/comms/conversations/{conversation_id}/messages/{message.id}"
            )
        return _version(response, message)
    except SendRateLimited as exc:
        refused = error("comms_rate_limited", "Wait before sending again", 429)
        refused.headers = {"Retry-After": str(exc.retry_after)}
        raise refused from exc
    except SendConflict as exc:
        raise error(
            "comms_idempotency_mismatch", "Client key identifies a different send", 409
        ) from exc
    except InvalidSend as exc:
        raise error("comms_invalid_input", "Message cannot be sent", 422) from exc
    except SQLAlchemyError as exc:
        db.rollback()
        raise error("comms_unavailable", "Message unavailable", 503) from exc


def _change_message(
    db: AuditSession,
    user: User,
    conversation_id: UUID,
    message_id: UUID,
    request: EditRequest | None,
) -> CommsMessage:
    require_conversation_access(db, user, conversation_id, "read")
    _counter(db, conversation_id)
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
        counter = _counter(db, conversation_id)
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
            pref.manual_unread = False
        result = ReadResponse(conversation_id=conversation_id, last_read_seq=row.last_read_seq)
        db.commit()
        _private(response)
        return result
    except SQLAlchemyError as exc:
        db.rollback()
        raise error("comms_unavailable", "Read state unavailable", 503) from exc
