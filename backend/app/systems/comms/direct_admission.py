"""Set projection of canonical direct-start admission, shared by starts and bounded discovery."""

from collections.abc import Collection
from uuid import UUID

from sqlalchemy import and_, case, or_, select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.policy.readers import active_account_clause
from app.systems.access.users.membership import bound_membership_join
from app.systems.access.users.models import Membership, User
from app.systems.access.users.person_visibility import visible_person_ids
from app.systems.comms.access import (
    conversation_reader_statement,
    fresh_membership,
    visible_conversation_clause,
)
from app.systems.comms.conversations.models import CommsConversation, CommsDirectBlock
from app.systems.comms.settings.resolution import resolve_settings


def admitted_direct_ids(db: Session, user: User, candidate_ids: Collection[UUID]) -> set[UUID]:
    membership = fresh_membership(db, user)
    if membership is None or membership.role == "guest" or not candidate_ids:
        return set()
    targets = set(
        db.scalars(
            select(User.id)
            .join(Membership, bound_membership_join())
            .where(
                User.id.in_(candidate_ids),
                User.id != user.id,
                active_account_clause(),
                Membership.role != "guest",
            )
        )
    )
    targets &= visible_person_ids(db, user, targets)
    if not targets:
        return set()
    block = CommsDirectBlock
    blocked = set(
        db.scalars(
            select(
                case(
                    (block.user_id == user.id, block.blocked_user_id),
                    else_=block.user_id,
                )
            ).where(
                block.org_id == bound_organization_column(),
                block.is_deleted.is_(False),
                or_(
                    and_(block.user_id == user.id, block.blocked_user_id.in_(targets)),
                    and_(block.blocked_user_id == user.id, block.user_id.in_(targets)),
                ),
            )
        )
    )
    targets -= blocked
    rule = resolve_settings(db, {"kind": "workspace"})["dm_rule"]
    if rule == "none":
        return set()
    if rule == "everyone" or not targets:
        return targets
    channels = select(CommsConversation.id).where(
        CommsConversation.kind == "channel",
        visible_conversation_clause(db, user),
    )
    return set(db.scalars(conversation_reader_statement(channels, targets)))
