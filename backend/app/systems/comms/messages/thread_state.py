"""One-level thread identities and page-bounded projections shared with message reads."""

from collections.abc import Collection
from hashlib import sha256
from uuid import UUID

from fastapi import Response
from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session

from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database.organization_scope import bound_organization_column
from app.systems.access.users.models import User
from app.systems.comms.access import error, require_conversation_access, visible_conversation_clause
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.messages.interaction_models import CommsThread, CommsThreadFollow
from app.systems.comms.messages.interaction_schemas import ThreadList, TimeSort
from app.systems.comms.messages.models import CommsConversationCounter, CommsMessage
from app.systems.comms.messages.schemas import ThreadResponse


def root(
    db: Session,
    user: User,
    conversation: UUID,
    identity: UUID,
    *,
    lock: bool = False,
    shared: bool = False,
) -> CommsMessage:
    require_conversation_access(db, user, conversation, "read")
    if lock:
        db.scalar(
            select(CommsConversationCounter)
            .where(
                CommsConversationCounter.org_id == bound_organization_column(),
                CommsConversationCounter.conversation_id == conversation,
            )
            .with_for_update(read=shared)
            .execution_options(populate_existing=True)
        )
        db.scalar(
            select(CommsConversation)
            .where(
                CommsConversation.org_id == bound_organization_column(),
                CommsConversation.id == conversation,
            )
            .with_for_update(read=shared)
        )
        require_conversation_access(db, user, conversation, "read")
    query = (
        select(CommsMessage)
        .where(
            CommsMessage.org_id == bound_organization_column(),
            CommsMessage.conversation_id == conversation,
            CommsMessage.id == identity,
            CommsMessage.parent_id.is_(None),
        )
        .execution_options(populate_existing=True)
    )
    row = db.scalar(query.with_for_update(read=shared) if lock else query)
    if row is None:
        raise error("comms_not_found", "Thread root not found")
    return row


def get(db: Session, message: CommsMessage) -> CommsThread | None:
    return db.scalar(
        select(CommsThread)
        .where(
            CommsThread.org_id == bound_organization_column(),
            CommsThread.conversation_id == message.conversation_id,
            CommsThread.root_message_id == message.id,
            CommsThread.is_deleted.is_(False),
        )
        .execution_options(populate_existing=True)
    )


def follow(db: Session, user: User, message: CommsMessage, enabled: bool) -> None:
    row = db.scalar(
        select(CommsThreadFollow)
        .where(
            CommsThreadFollow.org_id == bound_organization_column(),
            CommsThreadFollow.root_message_id == message.id,
            CommsThreadFollow.user_id == user.id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if enabled and row is None:
        db.add(
            CommsThreadFollow(org_id=message.org_id, root_message_id=message.id, user_id=user.id)
        )
    elif not enabled and row is not None:
        db.delete(row)


def project(db: Session, user_id: UUID, roots: Collection[UUID]) -> dict[UUID, ThreadResponse]:
    followed = set(
        db.scalars(
            select(CommsThreadFollow.root_message_id).where(
                CommsThreadFollow.org_id == bound_organization_column(),
                CommsThreadFollow.user_id == user_id,
                CommsThreadFollow.root_message_id.in_(roots),
                CommsThreadFollow.is_deleted.is_(False),
            )
        )
    )
    return {
        thread.root_message_id: ThreadResponse(
            id=thread.id,
            org_id=thread.org_id,
            conversation_id=thread.conversation_id,
            root_message_id=thread.root_message_id,
            name=thread.name,
            resolved=thread.resolved,
            locked=thread.locked,
            archived=thread.archived,
            followed=thread.root_message_id in followed,
            reply_count=count,
            last_reply_at=latest,
        )
        for thread, count, latest in db.execute(
            select(CommsThread, CommsMessage.reply_count, CommsMessage.last_reply_at)
            .join(CommsMessage, CommsMessage.id == CommsThread.root_message_id)
            .where(
                CommsThread.org_id == bound_organization_column(),
                CommsMessage.org_id == bound_organization_column(),
                CommsThread.root_message_id.in_(roots),
                CommsThread.is_deleted.is_(False),
            )
        )
    }


def version(row: CommsThread, message: CommsMessage) -> str:
    data = (
        row.id,
        row.name,
        row.resolved,
        row.locked,
        row.archived,
        row.updated_at,
        message.reply_count,
        message.last_reply_at,
    )
    return '"' + sha256(str(data).encode()).hexdigest() + '"'


def response(db: Session, user: User, message: CommsMessage, output: Response) -> ThreadResponse:
    db.flush()
    row = get(db, message)
    if row is None:
        raise error("comms_not_found", "Thread not found")
    output.headers["Cache-Control"] = "private, no-store"
    output.headers["ETag"] = version(row, message)
    return project(db, user.id, [message.id])[message.id]


def listing(db: Session, user: User, request: ThreadList) -> StandardListResponse[ThreadResponse]:
    t, m = CommsThread, CommsMessage
    followed = exists(
        select(CommsThreadFollow.id).where(
            CommsThreadFollow.org_id == bound_organization_column(),
            CommsThreadFollow.user_id == user.id,
            CommsThreadFollow.root_message_id == t.root_message_id,
            CommsThreadFollow.is_deleted.is_(False),
        )
    ).correlate(t)
    query = (
        select(t)
        .join(m, m.id == t.root_message_id)
        .join(CommsConversation, CommsConversation.id == t.conversation_id)
        .where(
            t.org_id == bound_organization_column(),
            m.org_id == bound_organization_column(),
            t.is_deleted.is_(False),
            t.archived == request.archived,
            visible_conversation_clause(db, user),
        )
    )
    if request.followed is not None:
        query = query.where(followed if request.followed else ~followed)
    if request.resolved is not None:
        query = query.where(t.resolved == request.resolved)
    result = execute_standard_list(
        db,
        query,
        StandardListRequest[TimeSort](
            **request.model_dump(exclude={"followed", "resolved", "archived"})
        ),
        ListQuerySpec(
            sort_fields={
                TimeSort.CREATED: m.created_at.expression,
                TimeSort.UPDATED: func.coalesce(m.last_reply_at, m.created_at),
            },
            default_sort=TimeSort.CREATED,
            tie_breaker=t.id.expression,
        ),
    )
    projected = project(db, user.id, [row.root_message_id for row in result.items])
    return StandardListResponse(
        items=[projected[row.root_message_id] for row in result.items], pagination=result.pagination
    )
