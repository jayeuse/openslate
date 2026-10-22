"""Organization presence and stateless authorized high-water recovery."""

from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import and_, case, exists, func, literal, or_, select, text
from sqlalchemy.orm import Session

from app.core import base_model
from app.core.database.organization_scope import bound_organization_column
from app.systems.access.policy.readers import active_account_clause
from app.systems.access.users.membership import bound_membership_join, bound_organization
from app.systems.access.users.models import Membership, User
from app.systems.access.users.person_visibility import visible_person_ids
from app.systems.comms.access import error, fresh_membership, visible_conversation_clause
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.messages.models import CommsConversationCounter
from app.systems.comms.realtime.models import CommsPresence
from app.systems.comms.realtime.publication import stage_comms_event
from app.systems.comms.realtime.schemas import (
    ConversationHead,
    HeartbeatResponse,
    PresenceSnapshot,
    PresenceState,
)
from app.systems.comms.settings.models import CommsMemberPreferences
from app.systems.manage.audit.context import set_audit_actor

GRACE_SECONDS = 120


def presence_event(db: Session, user_id: UUID, state: str) -> None:
    org = bound_organization(db)
    stage_comms_event(
        db,
        org_id=org,
        actor_id=user_id,
        envelope={
            "topic": f"org:{org}:presence",
            "event": "presence",
            "private": True,
            "payload": {"user_id": str(user_id), "state": state},
        },
    )


def heartbeat(db: Session, actor: User, state: str) -> None:
    org = bound_organization(db)
    db.connection().execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"comms:presence:{org}:{actor.id}"},
    )
    row = db.scalar(
        select(CommsPresence)
        .where(CommsPresence.org_id == org, CommsPresence.user_id == actor.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if fresh_membership(db, actor) is None:
        raise error("comms_not_found", "Person not found")
    changed = row is None or row.state != state
    if row is None:
        row = CommsPresence(org_id=org, user_id=actor.id)
        db.add(row)
    row.state, row.last_seen_at = state, base_model.utc_now()
    if changed:
        presence_event(db, actor.id, state)


def watermarks(db: Session, actor: User, known: list[ConversationHead]) -> HeartbeatResponse:
    c, counter, pref = CommsConversation, CommsConversationCounter, CommsMemberPreferences
    org = bound_organization_column()
    current = func.coalesce(counter.last_seq, 0)
    baseline = (
        case({row.conversation_id: row.high_water_seq for row in known}, value=c.id)
        if known
        else literal(None)
    )
    active_mute = or_(
        pref.mute == "indefinite",
        and_(pref.mute == "until", pref.muted_until > base_model.utc_now()),
    )
    muted = exists(
        select(pref.id).where(
            pref.org_id == org,
            pref.user_id == actor.id,
            pref.is_deleted.is_(False),
            pref.deleted_at.is_(None),
            or_(
                and_(pref.conversation_id == c.id, pref.notify == "mute"),
                and_(
                    or_(pref.conversation_id == c.id, pref.category_id == c.category_id),
                    active_mute,
                ),
            ),
        )
    ).correlate(c)
    rows = db.execute(
        select(c.id, current)
        .outerjoin(counter, and_(counter.org_id == org, counter.conversation_id == c.id))
        .where(
            visible_conversation_clause(db, actor),
            c.archived_at.is_(None),
            ~muted,
            current.is_distinct_from(baseline),
        )
        .order_by(c.id)
        .limit(101)
    ).all()
    return HeartbeatResponse(
        org_id=bound_organization(db),
        user_id=actor.id,
        changed=[
            ConversationHead(conversation_id=identity, high_water_seq=head)
            for identity, head in rows[:100]
        ],
        truncated=len(rows) > 100,
    )


def snapshot(db: Session, actor: User, requested: list[UUID]) -> PresenceSnapshot:
    visible = visible_person_ids(db, actor, requested)
    rows = {
        row.user_id: row.state
        for row in db.scalars(
            select(CommsPresence).where(
                CommsPresence.org_id == bound_organization_column(),
                CommsPresence.user_id.in_(visible),
            )
        )
    }
    return PresenceSnapshot(
        org_id=bound_organization(db),
        items=[
            PresenceState.model_validate(
                {"user_id": identity, "state": rows.get(identity, "offline")}
            )
            for identity in requested
            if identity in visible
        ],
    )


def sweep_presence(db: Session, now: datetime) -> int:
    rows = db.scalars(
        select(CommsPresence)
        .where(
            CommsPresence.org_id == bound_organization_column(),
            CommsPresence.state != "offline",
            CommsPresence.last_seen_at <= now - timedelta(seconds=GRACE_SECONDS),
        )
        .order_by(CommsPresence.user_id)
        .with_for_update(skip_locked=True)
        .execution_options(populate_existing=True)
    ).all()
    if not rows:
        return 0
    active = set(
        db.scalars(
            select(User.id)
            .join(Membership, bound_membership_join())
            .where(
                User.id.in_([row.user_id for row in rows]),
                active_account_clause(),
            )
        )
    )
    for row in rows:
        row.state = "offline"
        # Server expiry of unaudited presence; no user-authored mutation or body is manufactured.
        if row.user_id in active:
            set_audit_actor(db, row.user_id)
            presence_event(db, row.user_id, "offline")
    return len(rows)
