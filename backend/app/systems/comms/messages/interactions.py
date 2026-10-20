"""Personal reactions, manager pins and current captured-source record reads."""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, select

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.core.database.session import AuditSession, get_db
from app.systems.access.users.models import User
from app.systems.comms.access import error, require_conversation_access
from app.systems.comms.capabilities import capability_check
from app.systems.comms.conversations.service import private, transaction
from app.systems.comms.messages import links
from app.systems.comms.messages.interaction_models import CommsReaction
from app.systems.comms.messages.interaction_schemas import (
    PinRequest,
    ReactionRequest,
    TimeList,
    TimeSort,
)
from app.systems.comms.messages.link_models import CommsMessageRecordLink
from app.systems.comms.messages.models import CommsConversationCounter, CommsMessage
from app.systems.comms.messages.reads import get_message, project_messages
from app.systems.comms.messages.schemas import AvailableRecord, MessageResponse, UnavailableRecord
from app.systems.comms.realtime.events import message_event
from app.systems.comms.settings.resolution import Scope, resolve_settings

DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]
router = APIRouter(prefix="/comms", tags=["comms"], dependencies=[Depends(get_current_membership)])
M = "/conversations/{conversation_id}/messages/{message_id}"


def _live(db: AuditSession, actor: User, conversation: UUID, identity: UUID) -> CommsMessage:
    require_conversation_access(db, actor, conversation, "read")
    db.scalar(
        select(CommsConversationCounter)
        .where(
            CommsConversationCounter.org_id == bound_organization_column(),
            CommsConversationCounter.conversation_id == conversation,
        )
        .with_for_update()
    )
    require_conversation_access(db, actor, conversation, "read")
    row = get_message(db, conversation, message_id=identity, lock=True)
    if row.is_deleted or row.deleted_at:
        raise error("comms_not_found", "Message not found")
    return row


def _reaction(
    db: AuditSession,
    actor: User,
    conversation: UUID,
    identity: UUID,
    emoji: str,
    enabled: bool,
    response: Response,
) -> Any:
    with transaction(db):
        message = _live(db, actor, conversation, identity)
        if not capability_check(db, actor, conversation)["capabilities"]["react"]["allowed"]:
            raise error("comms_capability_denied", "Capability required", 403)
        parent = require_conversation_access(db, actor, conversation, "read")
        scope: Scope = (
            {"kind": "channel", "id": conversation}
            if parent.kind == "channel"
            else {"kind": "workspace"}
        )
        if emoji not in resolve_settings(db, scope)["effective"]["allowed_reactions"]:
            raise error("comms_invalid_input", "Reaction is not allowed", 422)
        row = db.scalar(
            select(CommsReaction)
            .where(
                CommsReaction.org_id == bound_organization_column(),
                CommsReaction.message_id == identity,
                CommsReaction.user_id == actor.id,
                CommsReaction.emoji == emoji,
            )
            .with_for_update()
        )
        if enabled and row is None:
            db.add(
                CommsReaction(
                    org_id=message.org_id, message_id=identity, user_id=actor.id, emoji=emoji
                )
            )
            message_event(db, conversation, message.seq, "reaction")
        elif not enabled and row is not None:
            db.delete(row)
            message_event(db, conversation, message.seq, "reaction")
        db.flush()
        result = project_messages(db, actor.id, [message])[0]
        private(response)
    return result


@router.post(M + "/reactions", response_model=MessageResponse)
def add_reaction(
    conversation_id: UUID,
    message_id: UUID,
    payload: ReactionRequest,
    db: DB,
    actor: Actor,
    response: Response,
) -> Any:
    return _reaction(db, actor, conversation_id, message_id, payload.emoji, True, response)


@router.delete(M + "/reactions", response_model=MessageResponse)
def remove_reaction(
    conversation_id: UUID,
    message_id: UUID,
    payload: ReactionRequest,
    db: DB,
    actor: Actor,
    response: Response,
) -> Any:
    return _reaction(db, actor, conversation_id, message_id, payload.emoji, False, response)


@router.put(M + "/pin", response_model=MessageResponse)
def set_pin(
    conversation_id: UUID,
    message_id: UUID,
    payload: PinRequest,
    db: DB,
    actor: Actor,
    response: Response,
) -> Any:
    with transaction(db):
        message = _live(db, actor, conversation_id, message_id)
        if not capability_check(db, actor, conversation_id)["capabilities"]["pin"]["allowed"]:
            raise error("comms_capability_denied", "Capability required", 403)
        if bool(message.pinned_at) != payload.pinned:
            message.pinned_at = utc_now() if payload.pinned else None
            message.pinned_by = actor.id if payload.pinned else None
            message_event(db, conversation_id, message.seq, "pin")
        db.flush()
        result = project_messages(db, actor.id, [message])[0]
        private(response)
    return result


@router.get(
    "/conversations/{conversation_id}/pins", response_model=StandardListResponse[MessageResponse]
)
def list_pins(
    conversation_id: UUID,
    db: DB,
    actor: Actor,
    response: Response,
    request: Annotated[TimeList, Query()],
) -> Any:
    require_conversation_access(db, actor, conversation_id, "read")
    m = CommsMessage
    result = execute_standard_list(
        db,
        select(m).where(
            m.org_id == bound_organization_column(),
            m.conversation_id == conversation_id,
            m.is_deleted.is_(False),
            m.deleted_at.is_(None),
            m.pinned_at.is_not(None),
        ),
        StandardListRequest[TimeSort](**request.model_dump()),
        ListQuerySpec(
            sort_fields={
                TimeSort.CREATED: m.created_at.expression,
                TimeSort.UPDATED: m.pinned_at.expression,
            },
            default_sort=TimeSort.CREATED,
            tie_breaker=m.id.expression,
        ),
    )
    private(response)
    return StandardListResponse(
        items=project_messages(db, actor.id, result.items), pagination=result.pagination
    )


@router.get(
    "/conversations/{conversation_id}/record-references/{reference_id}",
    response_model=AvailableRecord | UnavailableRecord,
)
def get_reference(
    conversation_id: UUID, reference_id: UUID, db: DB, actor: Actor, response: Response
) -> Any:
    require_conversation_access(db, actor, conversation_id, "read")
    row = db.scalar(
        links.reference_query(db, actor).where(
            CommsMessage.conversation_id == conversation_id,
            CommsMessageRecordLink.id == reference_id,
        )
    )
    if row is None:
        raise error("comms_not_found", "Record reference not found")
    private(response)
    return links.project_records(db, actor, [row])[row.id]


@router.get(
    "/record-references", response_model=StandardListResponse[AvailableRecord | UnavailableRecord]
)
def list_references(
    db: DB, actor: Actor, response: Response, request: Annotated[TimeList, Query()]
) -> Any:
    result = execute_standard_list(
        db,
        links.reference_query(db, actor),
        StandardListRequest[TimeSort](**request.model_dump()),
        ListQuerySpec(
            sort_fields={
                TimeSort.CREATED: CommsMessage.created_at.expression,
                TimeSort.UPDATED: func.coalesce(CommsMessage.edited_at, CommsMessage.created_at),
            },
            default_sort=TimeSort.CREATED,
            tie_breaker=CommsMessageRecordLink.id.expression,
        ),
    )
    projected = links.project_records(db, actor, result.items)
    private(response)
    return StandardListResponse(
        items=[projected[row.id] for row in result.items], pagination=result.pagination
    )
