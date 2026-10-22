"""Trusted S01 event constructors shared by current Comms writers."""

from typing import Any, Literal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.policy.readers import active_account_clause
from app.systems.access.users.membership import bound_membership_join, bound_organization
from app.systems.access.users.models import Membership, User
from app.systems.comms.access import conversation_reader_ids
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.realtime.publication import stage_comms_event
from app.systems.manage.audit.context import get_audit_context


def actor_id(db: Session) -> UUID:
    identity = get_audit_context(db).performed_by
    if identity is None:
        raise ValueError("Event actor is required")
    return identity


def message_event(
    db: Session,
    conversation_id: UUID,
    seq: int,
    kind: Literal["created", "edited", "deleted", "reaction", "pin", "thread"],
) -> None:
    org = bound_organization(db)
    stage_comms_event(
        db,
        org_id=org,
        actor_id=actor_id(db),
        envelope={
            "topic": f"org:{org}:conversation:{conversation_id}",
            "private": True,
            "event": "message",
            "payload": {"conversation_id": str(conversation_id), "seq": seq, "kind": kind},
        },
    )


def user_event(
    db: Session,
    recipient: UUID,
    kind: Literal["read", "membership", "grants", "structure", "notification"],
    payload: dict[str, Any],
) -> None:
    org = bound_organization(db)
    stage_comms_event(
        db,
        org_id=org,
        actor_id=actor_id(db),
        recipient_id=recipient,
        envelope={
            "topic": f"org:{org}:user:{recipient}",
            "private": True,
            "event": kind,
            "payload": payload,
        },
    )


def organization_event(db: Session, kind: Literal["structure", "grants"]) -> None:
    recipients = db.scalars(
        select(User.id)
        .join(Membership, bound_membership_join())
        .where(
            Membership.org_id == bound_organization_column(),
            active_account_clause(),
        )
    )
    for recipient in recipients:
        user_event(db, recipient, kind, {})


def membership_event(db: Session, conversation: CommsConversation, subject_id: UUID) -> None:
    for recipient in conversation_reader_ids(db, conversation) | {subject_id}:
        user_event(db, recipient, "membership", {"conversation_id": str(conversation.id)})
