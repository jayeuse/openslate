"""Load one bounded conversation's manager audience through the canonical D27 evaluator."""

from collections import defaultdict
from typing import cast
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.policy.models import Group, GroupMember
from app.systems.access.policy.readers import active_account_clause
from app.systems.access.users.membership import bound_membership_join
from app.systems.access.users.models import Membership, User
from app.systems.comms.access import (
    LEVELS,
    ConversationAccess,
    ManagerSource,
    _conversation_access_statement,
)
from app.systems.comms.capabilities import CapabilityInputs, Grant, capability_decision
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.settings.models import CommsCapabilityGrant
from app.systems.comms.settings.resolution import (
    locked_keys,
    normalize_scope,
    scope_clause,
    scope_context,
)


def managers(db: Session, conversation_id: UUID) -> set[UUID]:
    context = scope_context(db, {"kind": "channel", "id": conversation_id})
    candidates = list(
        db.scalars(
            select(User.id)
            .join(Membership, bound_membership_join())
            .where(
                active_account_clause(),
            )
        )
    )
    if not candidates:
        return set()
    access = (
        db.execute(
            _conversation_access_statement(
                select(CommsConversation.id).where(CommsConversation.id == conversation_id),
                candidates,
            )
        )
        .mappings()
        .all()
    )
    groups: dict[UUID, set[UUID]] = defaultdict(set)
    for user, group in db.execute(
        select(GroupMember.user_id, GroupMember.group_id)
        .join(
            Group,
            Group.id == GroupMember.group_id,
        )
        .where(
            Group.org_id == bound_organization_column(),
            Group.is_deleted.is_(False),
            GroupMember.org_id == bound_organization_column(),
            GroupMember.is_deleted.is_(False),
            GroupMember.user_id.in_(candidates),
        )
    ):
        groups[user].add(group)
    grants = []
    for row, name in db.execute(
        select(CommsCapabilityGrant, Group.name)
        .outerjoin(
            Group,
            Group.id == CommsCapabilityGrant.group_id,
        )
        .where(or_(*(scope_clause(CommsCapabilityGrant, scope) for scope in context.chain)))
    ):
        scope = normalize_scope(
            {
                "kind": row.scope,
                **(
                    {"id": row.category_id or row.conversation_id}
                    if row.scope != "workspace"
                    else {}
                ),
            }
        )
        grants.append(Grant(row.capability, scope, row.granted, row.group_id, name))
    grants.sort(key=lambda item: (context.chain.index(item.scope), str(item.group_id)))
    locks = frozenset(locked_keys(db, "capability"))
    return {
        row["user_id"]
        for row in access
        if capability_decision(
            "manageChannel",
            CapabilityInputs(
                row["role"],
                ConversationAccess(
                    LEVELS[row["level"]],
                    cast(ManagerSource | None, row["manager"]),
                    {"kind": "none" if not row["level"] else "current"},
                ),
                context.chain,
                tuple(
                    grant
                    for grant in grants
                    if grant.group_id is None or grant.group_id in groups[row["user_id"]]
                ),
                locks,
                None,
            ),
        )["allowed"]
    }
