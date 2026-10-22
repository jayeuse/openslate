"""Body-free bootstrap built from bounded set projections, never per-channel policy calls."""

from collections import defaultdict
from collections.abc import Collection, Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import and_, case, exists, false, func, or_, select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.policy.readers import active_account_clause
from app.systems.access.users.membership import bound_membership_join, bound_organization
from app.systems.access.users.models import Membership, User
from app.systems.comms.access import (
    LEVELS,
    _conversation_access_statement,
    conversation_reader_counts,
)
from app.systems.comms.conversations.models import (
    CommsCategory,
    CommsConversation,
    CommsMember,
)
from app.systems.comms.messages.interaction_models import CommsMention
from app.systems.comms.messages.models import CommsConversationCounter, CommsMessage, CommsReadState
from app.systems.comms.messages.schemas import BootstrapResponse
from app.systems.comms.settings.models import CommsMemberPreferences
from app.systems.comms.settings.resolution import channel_effective_settings


def _mute(row: CommsMemberPreferences) -> dict[str, Any]:
    return (
        {"kind": "until", "until": row.muted_until} if row.mute == "until" else {"kind": row.mute}
    )


# A member row is a role; a name only for a person visible under D36 (an active member).
People = dict[UUID, tuple[str, str | None]]


def conversation_people(db: Session, ids: Collection[UUID]) -> defaultdict[UUID, People]:
    """Member rows of many conversations, with names, in one statement."""
    name = case(
        (
            active_account_clause(),
            func.coalesce(func.nullif(User.display_name, ""), User.username),
        ),
        else_=None,
    )
    people: defaultdict[UUID, People] = defaultdict(dict)
    for conversation, person, role, display_name in db.execute(
        select(CommsMember.conversation_id, CommsMember.user_id, CommsMember.role, name)
        .join(User, User.id == CommsMember.user_id)
        .outerjoin(Membership, bound_membership_join())
        .where(
            CommsMember.org_id == bound_organization_column(),
            CommsMember.conversation_id.in_(ids),
            CommsMember.is_deleted.is_(False),
            CommsMember.deleted_at.is_(None),
        )
    ).tuples():
        people[conversation][person] = role, display_name
    return people


def project_conversation(
    row: CommsConversation,
    actor: UUID,
    level: str,
    people: People,
    readers: int,
    settings: Mapping[str, Any],
) -> dict[str, Any]:
    """``people`` are member rows; ``readers`` counts a channel's readers (D44).

    On a channel the actor is a "manager" exactly at manage level (D44 A6);
    ``settings`` are a channel's effective settings and unused elsewhere.
    """
    channel = row.kind == "channel"
    common: dict[str, Any] = {
        "id": row.id,
        "org_id": row.org_id,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "archived_at": row.archived_at,
        "level": level,
        # A channel's members are its readers; a role row only marks a manager.
        "member_count": readers if channel else len(people),
        "member_role": ("manager" if level == "manage" else "member")
        if channel
        else people[actor][0] if actor in people else None,
        "kind": row.kind,
    }
    if not channel:
        common["participant_ids"] = sorted(people)
        common["participants"] = [
            {"user_id": person, "display_name": people[person][1]} for person in sorted(people)
        ]
        if row.kind == "group":
            common["name"] = row.name
    else:
        common.update(
            name=row.name,
            topic=row.topic,
            category_id=row.category_id,
            position=row.position,
            scope=row.scope,
            thread_branches=settings["thread_branches"],
        )
        if row.scope == "department":
            common["department_id"] = row.department_id
    return common


def bootstrap(db: Session, user: User) -> BootstrapResponse:
    org = bound_organization_column()
    c, m, read = CommsConversation, CommsMessage, CommsReadState
    policy = _conversation_access_statement(select(c.id), [user.id]).subquery()
    rows = db.execute(
        select(
            c,
            policy.c.level,
            CommsConversationCounter.last_seq,
            func.coalesce(read.last_read_seq, 0),
        )
        .join(
            policy,
            policy.c.conversation_id == c.id,
        )
        .outerjoin(
            CommsConversationCounter,
            and_(
                CommsConversationCounter.org_id == org,
                CommsConversationCounter.conversation_id == c.id,
            ),
        )
        .outerjoin(
            read,
            and_(
                read.org_id == org,
                read.conversation_id == c.id,
                read.user_id == user.id,
                read.is_deleted.is_(False),
            ),
        )
        .where(c.org_id == org, policy.c.level > 0)
        .order_by(c.position, c.id)
    ).all()
    ids = [row[0].id for row in rows]
    channel_ids = [row[0].id for row in rows if row[0].kind == "channel"]
    readers = conversation_reader_counts(db, channel_ids)
    members = conversation_people(db, ids)
    settings = channel_effective_settings(db, [row[0] for row in rows if row[0].kind == "channel"])
    preferences = db.scalars(
        select(CommsMemberPreferences).where(
            CommsMemberPreferences.org_id == org,
            CommsMemberPreferences.user_id == user.id,
            CommsMemberPreferences.is_deleted.is_(False),
            or_(
                CommsMemberPreferences.category_id.is_not(None),
                CommsMemberPreferences.conversation_id.in_(ids),
            ),
        )
    ).all()
    personal = {row.conversation_id: row for row in preferences if row.conversation_id}
    category_preferences = {row.category_id: row for row in preferences if row.category_id}
    categories = db.scalars(
        select(CommsCategory)
        .where(
            CommsCategory.org_id == org,
            CommsCategory.is_deleted.is_(False),
            CommsCategory.deleted_at.is_(None),
        )
        .order_by(CommsCategory.position, CommsCategory.id)
    ).all()
    mentioned = exists(
        select(CommsMention.id).where(
            CommsMention.org_id == org,
            CommsMention.message_id == m.id,
            CommsMention.user_id == user.id,
            CommsMention.is_deleted.is_(False),
        )
    ).correlate(m)
    channel_member = exists(
        select(CommsMember.id).where(
            CommsMember.org_id == org,
            CommsMember.conversation_id == m.conversation_id,
            CommsMember.user_id == user.id,
            CommsMember.is_deleted.is_(False),
            CommsMember.deleted_at.is_(None),
        )
    ).correlate(m)
    captured_ranges = or_(
        false(),
        *(
            and_(
                m.conversation_id == conversation.id,
                m.seq > min(watermark, high_water or 0),
                m.seq <= (high_water or 0),
            )
            for conversation, _level, high_water, watermark in rows
        ),
    )
    unread = {
        row[0]: row[1:]
        for row in db.execute(
            select(
                m.conversation_id,
                func.count(),
                func.min(m.seq),
                func.count().filter(
                    or_(
                        mentioned,
                        # Every channel reader is in @channel; elsewhere members are.
                        and_(
                            m.mentions_channel,
                            or_(m.conversation_id.in_(channel_ids), channel_member),
                        ),
                    )
                ),
            )
            .where(
                m.org_id == org,
                m.conversation_id.in_(ids),
                m.author_id != user.id,
                m.is_deleted.is_(False),
                m.deleted_at.is_(None),
                captured_ranges,
            )
            .group_by(m.conversation_id)
        )
    }
    summaries = []
    for conversation, level, high_water, watermark in rows:
        identity = conversation.id
        common = project_conversation(
            conversation,
            user.id,
            LEVELS[level],
            members[identity],
            readers.get(identity, 0),
            settings.get(identity, {}),
        )
        pref = personal.get(identity)
        count, first, mentions = unread.get(identity, (0, None, 0))
        summaries.append(
            {
                "conversation": common,
                "preferences": {}
                if pref is None
                else {
                    "notify": pref.notify,
                    "mute": _mute(pref),
                    "starred": pref.starred,
                    "hidden": pref.hidden,
                    "manual_unread": pref.manual_unread,
                },
                "last_read_seq": min(watermark, high_water or 0),
                "high_water_seq": high_water or 0,
                "unread_count": min(count, 100),
                "mention_count": min(mentions, 100),
                "first_unread_seq": first,
            }
        )
    return BootstrapResponse.model_validate(
        {
            "org_id": bound_organization(db),
            "user_id": user.id,
            "conversations": summaries,
            "categories": [
                {
                    "category": {
                        "id": row.id,
                        "org_id": row.org_id,
                        "created_at": row.created_at,
                        "updated_at": row.updated_at,
                        "name": row.name,
                        "position": row.position,
                        "department_id": row.department_id,
                    },
                    "preferences": {
                        "collapsed": category_preferences[row.id].collapsed,
                        "mute": _mute(category_preferences[row.id]),
                    }
                    if row.id in category_preferences
                    else {},
                }
                for row in categories
            ],
        }
    )
