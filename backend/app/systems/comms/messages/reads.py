"""Current message projections and bounded keyset history; no mutation or permission copy."""

from collections import defaultdict
from typing import Any
from uuid import UUID

from sqlalchemy import Select, exists, false, or_, select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.users.membership import bound_organization
from app.systems.comms.access import error
from app.systems.comms.messages import links, thread_state
from app.systems.comms.messages.interaction_models import (
    CommsMention,
    CommsReaction,
)
from app.systems.comms.messages.models import CommsConversationCounter, CommsMessage
from app.systems.comms.messages.schemas import (
    HistoryPagination,
    HistoryRequest,
    HistoryResponse,
    LiveMessage,
    Tombstone,
)
from app.systems.comms.previews.cache import cached_previews


def message_query(conversation_id: UUID) -> Select[tuple[CommsMessage]]:
    return (
        select(CommsMessage)
        .where(
            CommsMessage.org_id == bound_organization_column(),
            CommsMessage.conversation_id == conversation_id,
        )
        .execution_options(populate_existing=True)
    )


def project_messages(
    db: Session,
    user_id: UUID,
    rows: list[CommsMessage],
) -> list[LiveMessage | Tombstone]:
    org = bound_organization_column()
    live = [row.id for row in rows if not row.is_deleted and row.deleted_at is None]
    roots = {row.parent_id or row.id for row in rows}
    mentions: dict[UUID, list[UUID]] = defaultdict(list)
    for message, person in db.execute(
        select(CommsMention.message_id, CommsMention.user_id)
        .where(
            CommsMention.org_id == org,
            CommsMention.message_id.in_(live),
            CommsMention.is_deleted.is_(False),
            CommsMention.deleted_at.is_(None),
        )
        .order_by(CommsMention.user_id)
    ):
        mentions[message].append(person)
    reactions: dict[UUID, dict[str, list[UUID]]] = defaultdict(lambda: defaultdict(list))
    for message, emoji, person in db.execute(
        select(
            CommsReaction.message_id,
            CommsReaction.emoji,
            CommsReaction.user_id,
        )
        .where(
            CommsReaction.org_id == org,
            CommsReaction.message_id.in_(live),
            CommsReaction.is_deleted.is_(False),
            CommsReaction.deleted_at.is_(None),
        )
        .order_by(CommsReaction.emoji, CommsReaction.user_id)
    ):
        reactions[message][emoji].append(person)
    threads = thread_state.project(db, user_id, roots)
    live_rows = [row for row in rows if row.id in live]
    attachments = links.attachments(db, live_rows)
    records = links.message_records(db, user_id, live_rows)
    previews = cached_previews(db, live_rows)
    result: list[LiveMessage | Tombstone] = []
    for row in rows:
        identity: dict[str, Any] = {
            "id": row.id,
            "org_id": row.org_id,
            "conversation_id": row.conversation_id,
            "seq": row.seq,
            "author_id": row.author_id,
            "client_key": row.client_key,
            "created_at": row.created_at,
            "parent_id": row.parent_id,
            "reply_to_id": row.reply_to_id,
            "also_send_to_channel": row.also_send_to_channel,
            "thread": threads.get(row.parent_id or row.id),
        }
        if row.is_deleted or row.deleted_at is not None:
            if row.deleted_at is None:
                raise error("comms_unavailable", "Message unavailable", 503)
            result.append(Tombstone(**identity, state="deleted", deleted_at=row.deleted_at))
        else:
            result.append(
                LiveMessage(
                    **identity,
                    state="live",
                    body=row.body,
                    edited_at=row.edited_at,
                    pinned_at=row.pinned_at,
                    pinned_by=row.pinned_by,
                    mention_user_ids=mentions[row.id],
                    mentions_channel=row.mentions_channel,
                    mentions_here=row.mentions_here,
                    reactions=[
                        {"emoji": emoji, "user_ids": people}
                        for emoji, people in reactions[row.id].items()
                    ],
                    attachments=attachments[row.id],
                    record_references=records[row.id],
                    link_previews=previews.get(row.id, []),
                )
            )
    return result


def get_message(
    db: Session,
    conversation_id: UUID,
    *,
    message_id: UUID | None = None,
    seq: int | None = None,
    lock: bool = False,
) -> CommsMessage:
    query = message_query(conversation_id)
    query = (
        query.where(CommsMessage.id == message_id)
        if message_id
        else query.where(
            CommsMessage.seq == seq,
        )
    )
    if lock:
        query = query.with_for_update()
    message = db.scalar(query)
    if message is None:
        raise error("comms_not_found", "Message not found")
    return message


def history(
    db: Session,
    user_id: UUID,
    conversation_id: UUID,
    request: HistoryRequest,
    *, root_message_id: UUID | None = None,
) -> HistoryResponse:
    m = CommsMessage
    query = message_query(conversation_id).where(
        m.parent_id == root_message_id if root_message_id is not None else
        or_(m.parent_id.is_(None), m.also_send_to_channel)
    )
    high_water = (
        db.scalar(
            select(CommsConversationCounter.last_seq).where(
                CommsConversationCounter.org_id == bound_organization_column(),
                CommsConversationCounter.conversation_id == conversation_id,
            )
        )
        or 0
    )
    query = query.where(m.seq <= high_water)
    if request.around_seq is not None:
        before = db.scalars(
            query.with_only_columns(m.seq)
            .where(m.seq < request.around_seq)
            .order_by(m.seq.desc())
            .limit(request.limit)
        ).all()
        after = db.scalars(
            query.with_only_columns(m.seq)
            .where(m.seq >= request.around_seq)
            .order_by(m.seq)
            .limit(request.limit)
        ).all()
        candidates = sorted([*before, *after])
        pivot = len(before)
        start = max(0, min(len(candidates) - request.limit, pivot - request.limit // 2))
        selected = candidates[start : start + request.limit]
        rows = list(db.scalars(query.where(m.seq.in_(selected)).order_by(m.seq)))
    elif request.after_seq is not None:
        rows = list(
            db.scalars(query.where(m.seq > request.after_seq).order_by(m.seq).limit(request.limit))
        )
    else:
        page = query if request.before_seq is None else query.where(m.seq < request.before_seq)
        rows = list(reversed(db.scalars(page.order_by(m.seq.desc()).limit(request.limit)).all()))
    first, last = (rows[0].seq, rows[-1].seq) if rows else (None, None)
    older = query.with_only_columns(m.id).where(
        m.seq < first
        if first is not None
        else m.seq <= request.after_seq
        if request.after_seq is not None
        else false(),
    )
    newer = query.with_only_columns(m.id).where(
        m.seq > last
        if last is not None
        else m.seq >= request.before_seq
        if request.before_seq is not None
        else false(),
    )
    has_older, has_newer = db.execute(select(exists(older), exists(newer))).one()
    return HistoryResponse(
        org_id=bound_organization(db),
        conversation_id=conversation_id,
        thread_root_id=root_message_id,
        items=project_messages(db, user_id, rows),
        pagination=HistoryPagination(
            limit=request.limit,
            count=len(rows),
            first_seq=first,
            last_seq=last,
            high_water_seq=high_water,
            has_older=has_older,
            has_newer=has_newer,
        ),
    )
