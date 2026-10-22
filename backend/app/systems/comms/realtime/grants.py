"""Projection maintenance serialized before authority locks, never on the send path."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import User
from app.systems.comms.access import fresh_membership, readable_conversation_ids
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.realtime.events import organization_event
from app.systems.comms.realtime.models import CommsRealtimeGrant
from app.systems.manage.audit.context import get_audit_context


def lock_projection(db: Session) -> None:
    """ID30 order: org projection guard → authority rows → projection rows → commit.

    All relevant writers enter before their own locks. No sends take this guard.
    The transaction lock is released by SQL commit, before any provider I/O.
    """
    org = bound_organization(db)
    db.connection().execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"comms:realtime-grants:{org}"},
    )


def live_readable_ids(db: Session, actor: User) -> set[UUID]:
    if fresh_membership(db, actor) is None:
        return set()
    readable = readable_conversation_ids(db, actor)
    return set(
        db.scalars(
            select(CommsConversation.id).where(
                CommsConversation.org_id == bound_organization_column(),
                CommsConversation.id.in_(readable),
                CommsConversation.is_deleted.is_(False),
                CommsConversation.deleted_at.is_(None),
                CommsConversation.archived_at.is_(None),
            )
        )
    )


def reconcile(db: Session, actor: User, expires_at: datetime) -> list[str]:
    """Caller holds the org guard and commits before exposing the minted token."""
    org = bound_organization(db)
    ids = live_readable_ids(db, actor)
    rows = {
        row.conversation_id: row
        for row in db.scalars(
            select(CommsRealtimeGrant)
            .where(
                CommsRealtimeGrant.org_id == org,
                CommsRealtimeGrant.user_id == actor.id,
            )
            .execution_options(populate_existing=True)
        )
    }
    for identity, row in rows.items():
        if identity not in ids:
            db.delete(row)
        elif row.expires_at < expires_at:
            row.expires_at = expires_at
    for identity in ids - rows.keys():
        db.add(
            CommsRealtimeGrant(
                org_id=org, user_id=actor.id, conversation_id=identity, expires_at=expires_at
            )
        )
    return sorted(f"org:{org}:conversation:{identity}" for identity in ids)


def revoke_stale(db: Session) -> None:
    """After an authority write under the guard, remove only grants no longer readable.

    No renewals or grants for new readers: those belong to token reconciliation.
    """
    db.flush()
    rows = db.scalars(
        select(CommsRealtimeGrant).where(
            CommsRealtimeGrant.org_id == bound_organization_column(),
        )
    ).all()
    by_user: dict[UUID, set[UUID]] = {}
    for row in rows:
        if row.user_id not in by_user:
            actor = db.get(User, row.user_id, populate_existing=True)
            by_user[row.user_id] = live_readable_ids(db, actor) if actor else set()
        if row.conversation_id not in by_user[row.user_id]:
            db.delete(row)
    # Operator-only maintenance has no app actor and cannot forge a request event.
    if get_audit_context(db).performed_by is not None:
        organization_event(db, "grants")


def sweep_expired(db: Session, now: datetime) -> int:
    """One worker_organization pass; caller owns commit and session lifetime."""
    lock_projection(db)
    rows = db.scalars(
        select(CommsRealtimeGrant).where(
            CommsRealtimeGrant.org_id == bound_organization_column(),
            CommsRealtimeGrant.expires_at <= now,
        )
    ).all()
    for row in rows:
        db.delete(row)
    return len(rows)
