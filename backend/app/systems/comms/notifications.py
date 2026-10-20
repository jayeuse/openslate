"""Send-owned recipient references and current-source inbox admission; no alert engine."""

from collections.abc import Collection, Mapping
from datetime import datetime, timedelta
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import Select, and_, or_, select
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.systems.access.users.models import User
from app.systems.comms.access import conversation_reader_statement, visible_conversation_clause
from app.systems.comms.conversations.models import CommsConversation, CommsMember
from app.systems.comms.messages.interaction_models import CommsThreadFollow
from app.systems.comms.messages.models import CommsMessage
from app.systems.comms.realtime.events import user_event
from app.systems.comms.realtime.models import CommsPresence
from app.systems.comms.realtime.presence import GRACE_SECONDS
from app.systems.comms.settings.models import CommsMemberPreferences, CommsPersonalPreferences
from app.systems.comms.settings.resolution import Scope, resolve_settings
from app.systems.comms.settings.schemas import Notifications
from app.systems.platform.scheduling.models import InAppNotification, NotificationKind

COMMS_KINDS = (
    NotificationKind.COMMS_MENTION, NotificationKind.COMMS_DIRECT,
    NotificationKind.COMMS_THREAD_REPLY, NotificationKind.COMMS_KEYWORD,
)


class CommsNotificationResponse(BaseModel):
    id: UUID
    org_id: UUID
    kind: Literal["comms-mention", "comms-direct", "comms-thread-reply", "comms-keyword"]
    subject_type: Literal["comms_message"]
    subject_id: UUID
    conversation_id: UUID
    message_id: UUID
    status: Literal["unread", "read"]
    scheduled_for: None
    created_at: datetime
    read_at: datetime | None


def _keyword(body: str, words: Collection[str]) -> bool:
    return any(word.strip() and word.strip().lower() in body.lower() for word in words)


def _muted(preference: CommsMemberPreferences | None, now: datetime) -> bool:
    return preference is not None and (
        preference.notify == "mute" or preference.mute == "indefinite"
        or preference.mute == "until"
        and preference.muted_until is not None and preference.muted_until > now
    )


def _eligible(
    shared: Mapping[str, Any], personal: Mapping[str, Any], body: str,
    *, mentioned: bool, followed: bool, preference: CommsMemberPreferences | None,
) -> bool:
    # The frozen notificationDecision checks BOTH policies: personal cannot widen shared.
    policies = (shared, {**shared, **personal})
    if any(policy["notification_mode"] == "none" for policy in policies):
        return False
    if followed and any(not policy["notify_followed_threads"] for policy in policies):
        return False
    if not mentioned and (
        preference is not None and preference.notify == "mentions"
        or any(policy["notification_mode"] == "mentions" and not _keyword(body, policy["keywords"])
               for policy in policies)
    ):
        return False
    # Quiet hours, preview, badges, desktop and sound govern presentation, not durable inbox rows.
    return True


def stage_notifications(
    db: Session, message: CommsMessage, mentioned_ids: Collection[UUID],
) -> None:
    """No commit: the original send owns rows and the S20 after-response event buffer."""
    org = bound_organization_column()
    conversation = db.get(CommsConversation, message.conversation_id)
    assert conversation is not None
    scope: Scope = (
        {"kind": "channel", "id": conversation.id}
        if conversation.kind == "channel" else {"kind": "workspace"}
    )
    shared = resolve_settings(db, scope)["effective"]
    candidates = db.scalars(select(CommsMember.user_id).where(
        CommsMember.org_id == org, CommsMember.conversation_id == conversation.id,
        CommsMember.user_id != message.author_id,
        CommsMember.is_deleted.is_(False), CommsMember.deleted_at.is_(None),
    )).all()
    recipients = set(db.scalars(conversation_reader_statement(
        select(CommsConversation.id).where(CommsConversation.id == conversation.id), candidates,
    )))
    if not recipients:
        return
    personal = {
        row.user_id: Notifications.model_validate(row.values.get("notifications", {})).selected()
        for row in db.scalars(select(CommsPersonalPreferences).where(
            CommsPersonalPreferences.org_id == org,
            CommsPersonalPreferences.user_id.in_(recipients),
            CommsPersonalPreferences.is_deleted.is_(False),
            CommsPersonalPreferences.deleted_at.is_(None),
        ))
    }
    preferences = list(db.scalars(select(CommsMemberPreferences).where(
        CommsMemberPreferences.org_id == org, CommsMemberPreferences.user_id.in_(recipients),
        CommsMemberPreferences.is_deleted.is_(False), CommsMemberPreferences.deleted_at.is_(None),
        or_(CommsMemberPreferences.conversation_id == conversation.id,
            and_(CommsMemberPreferences.category_id.is_not(None),
                 CommsMemberPreferences.category_id == conversation.category_id)),
    )))
    member = {row.user_id: row for row in preferences if row.conversation_id is not None}
    now = utc_now()
    muted = {row.user_id for row in preferences if _muted(row, now)}
    followed = set(db.scalars(select(CommsThreadFollow.user_id).where(
        CommsThreadFollow.org_id == org, CommsThreadFollow.user_id.in_(recipients),
        CommsThreadFollow.root_message_id == message.parent_id,
        CommsThreadFollow.is_deleted.is_(False), CommsThreadFollow.deleted_at.is_(None),
    ))) if message.parent_id is not None else set()
    mentioned = set(mentioned_ids)
    if message.mentions_channel:
        mentioned.update(recipients)
    if message.mentions_here:
        mentioned.update(db.scalars(select(CommsPresence.user_id).where(
            CommsPresence.org_id == org, CommsPresence.user_id.in_(recipients),
            CommsPresence.state == "online",
            CommsPresence.last_seen_at > now - timedelta(seconds=GRACE_SECONDS),
        )))
    for recipient in sorted(recipients - muted):
        private = personal.get(recipient, {})
        kind = (
            NotificationKind.COMMS_MENTION if recipient in mentioned else
            NotificationKind.COMMS_DIRECT if conversation.kind != "channel" else
            NotificationKind.COMMS_THREAD_REPLY if recipient in followed else
            NotificationKind.COMMS_KEYWORD
            if _keyword(message.body, [*shared["keywords"], *private.get("keywords", [])]) else None
        )
        if kind is None or not _eligible(
            shared, private, message.body, mentioned=recipient in mentioned,
            followed=recipient in followed, preference=member.get(recipient),
        ):
            continue
        row = InAppNotification(
            org_id=message.org_id, recipient_id=recipient, kind=kind,
            subject_type="comms_message", subject_id=message.id,
            comms_conversation_id=conversation.id,
        )
        db.add(row)
        db.flush()
        user_event(db, recipient, "notification", {"id": str(row.id)})


def visible_notification_ids(db: Session, user: User) -> Select[tuple[UUID]]:
    """Both the captured conversation and the current source must still agree and be readable."""
    n, m, c = InAppNotification, CommsMessage, CommsConversation
    org = bound_organization_column()
    return (
        select(n.id)
        .join(m, and_(m.org_id == n.org_id, m.id == n.subject_id))
        .join(c, and_(c.org_id == n.org_id, c.id == n.comms_conversation_id))
        .where(
            n.org_id == org, n.recipient_id == user.id, n.kind.in_(COMMS_KINDS),
            n.subject_type == "comms_message", n.work_id.is_(None),
            n.is_deleted.is_(False), n.deleted_at.is_(None),
            m.conversation_id == n.comms_conversation_id,
            m.is_deleted.is_(False), m.deleted_at.is_(None),
            visible_conversation_clause(db, user),
        )
    )


def current_references(db: Session, user: User, ids: Collection[UUID]) -> dict[UUID, UUID]:
    if not ids:
        return {}
    return {
        identity: conversation for identity, conversation in db.execute(
            select(InAppNotification.id, InAppNotification.comms_conversation_id).where(
                InAppNotification.id.in_(ids),
                InAppNotification.id.in_(visible_notification_ids(db, user)),
                InAppNotification.comms_conversation_id.is_not(None),
            )
        ) if conversation is not None
    }
