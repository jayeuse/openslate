"""Current Comms access: one bounded relation, four projections, no cached grants."""

from collections.abc import Collection
from dataclasses import dataclass
from typing import Any, Literal, cast
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import Select, and_, case, func, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.policy.models import AccessLevel, Group, GroupMember
from app.systems.access.policy.readers import active_account_clause
from app.systems.access.policy.scope import department_level_clause
from app.systems.access.users.membership import (
    bound_membership_join,
    current_membership,
    organization_membership,
)
from app.systems.access.users.models import Membership, User
from app.systems.comms.conversations.models import (
    CommsChannelAccess,
    CommsConversation,
    CommsDirectBlock,
    CommsMember,
)

ConversationLevel = Literal["none", "read", "post", "manage"]
ManagerSource = Literal["creator", "membership_manager", "department_manager"]
LEVELS: tuple[ConversationLevel, ...] = ("none", "read", "post", "manage")


def error(code: str, message: str, status: int = 404) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def fresh_membership(db: Session, user: User) -> Membership | None:
    """Flush pending writes before refreshing both account and organization authority."""
    db.flush()
    current = db.scalar(
        select(User)
        .where(User.id == user.id)
        .execution_options(
            populate_existing=True,
        )
    )
    membership = organization_membership(db, user.id, fresh=True)
    if current is None or membership is None:
        return None
    return current_membership(db, current)


def _conversation_access_statement(
    conversation_ids: Select[tuple[UUID]],
    user_ids: Collection[UUID],
) -> Select[Any]:
    """Select only requested person/resource pairs; never materialize an org-wide matrix.

    The relation includes zero levels for explanations. Every public projection
    below reads it; D36 composes the same reader projection rather than another policy.
    """
    c, member = CommsConversation, CommsMember
    membership_role = (
        select(member.role)
        .where(
            member.org_id == bound_organization_column(),
            member.conversation_id == c.id,
            member.user_id == User.id,
            member.is_deleted.is_(False),
            member.deleted_at.is_(None),
        )
        .correlate(c, User)
        .scalar_subquery()
    )
    # The per-person form of department_level_reader_statement: it reads only this
    # person's group rows instead of rebuilding the department's whole reader set for
    # every (conversation, person) pair, which planned per pair and dominated cold reads.
    def department_level(minimum: AccessLevel) -> ColumnElement[bool]:
        return department_level_clause(
            User.id.expression, Membership.role.expression, c.department_id.expression, minimum,
        )

    manages_department = department_level(AccessLevel.MANAGE)
    manager = case(
        (and_(c.created_by == User.id, membership_role.is_not(None)), "creator"),
        (membership_role == "manager", "membership_manager"),
        (manages_department, "department_manager"),
        else_=None,
    )
    department_rank = case(
        (department_level(AccessLevel.WRITE), 2),
        (department_level(AccessLevel.READ), 1),
        else_=0,
    )
    # D45: the best added grant of this channel or of its current category, for the person
    # or one of their live groups; read 1, post 2, never manage. An organization channel
    # already gives post, and direct or group messages have no category, so only the
    # department arm reads it.
    groups = (
        select(GroupMember.group_id)
        .join(Group, Group.id == GroupMember.group_id)
        .where(
            GroupMember.org_id == bound_organization_column(),
            Group.org_id == bound_organization_column(),
            GroupMember.user_id == User.id,
            GroupMember.is_deleted.is_(False),
            Group.is_deleted.is_(False),
        )
        .correlate(User)
    )
    grant = CommsChannelAccess
    granted = func.coalesce(
        select(func.max(case((grant.level == "post", 2), else_=1)))
        .where(
            grant.org_id == bound_organization_column(),
            grant.is_deleted.is_(False),
            grant.deleted_at.is_(None),
            or_(
                grant.conversation_id == c.id,
                and_(c.category_id.is_not(None), grant.category_id == c.category_id),
            ),
            or_(
                and_(grant.subject == "user", grant.user_id == User.id),
                and_(grant.subject == "group", grant.group_id.in_(groups)),
            ),
        )
        .correlate(c, User)
        .scalar_subquery(),
        0,
    )
    ordinary = case(
        (c.scope == "organization", 2),
        (c.scope == "department", func.greatest(department_rank, granted)),
        (and_(c.scope == "members", membership_role.is_not(None)), 2),
        else_=0,
    )
    uncapped = case(
        (
            and_(
                Membership.role == "admin",
                or_(
                    c.scope != "members",
                    membership_role.is_not(None),
                ),
            ),
            3,
        ),
        (manager.is_not(None), 3),
        else_=ordinary,
    )
    level = case((Membership.role == "guest", func.least(uncapped, 1)), else_=uncapped)
    return (
        select(
            c.id.label("conversation_id"),
            User.id.label("user_id"),
            level.label("level"),
            Membership.role.label("role"),
            manager.label("manager"),
            and_(c.scope == "department", granted > department_rank).label("from_grant"),
            c.scope,
            c.department_id,
        )
        .select_from(c)
        .join(User, User.id.in_(user_ids))
        .join(
            Membership,
            bound_membership_join(),
        )
        .where(
            c.org_id == bound_organization_column(),
            c.id.in_(conversation_ids),
            c.is_deleted.is_(False),
            c.deleted_at.is_(None),
            active_account_clause(),
        )
    )


@dataclass(frozen=True)
class ConversationAccess:
    level: ConversationLevel
    manager_source: ManagerSource | None
    source: dict[str, Any]


def explain_conversation_access(
    db: Session,
    user: User,
    conversation_id: UUID,
) -> ConversationAccess:
    membership = fresh_membership(db, user)
    none = ConversationAccess(
        "none",
        None,
        {
            "kind": "none",
            "reason": "no_access" if membership else "inactive_membership",
        },
    )
    if membership is None:
        return none
    row = (
        db.execute(
            _conversation_access_statement(
                select(CommsConversation.id).where(CommsConversation.id == conversation_id),
                [user.id],
            )
        )
        .mappings()
        .first()
    )
    if row is None or row["level"] == 0:
        return none
    level = LEVELS[row["level"]]
    manager = cast(ManagerSource | None, row["manager"])
    if membership.role == "admin":
        source: dict[str, Any] = {"kind": "admin"}
        manager = None
    elif membership.role == "guest":
        source, manager = {"kind": "guest_cap"}, None
    elif manager:
        source = {"kind": "manager", "reason": manager}
    elif row["from_grant"]:
        source = {"kind": "grant"}
    elif row["scope"] == "department":
        source = {"kind": "department", "department_id": row["department_id"]}
    elif row["scope"] == "organization":
        source = {"kind": "organization"}
    else:
        source = {"kind": "membership"}
    return ConversationAccess(level, manager, source)


def conversation_level(
    db: Session,
    user: User,
    conversation: CommsConversation,
) -> ConversationLevel:
    return explain_conversation_access(db, user, conversation.id).level


def visible_conversation_clause(db: Session, user: User) -> ColumnElement[bool]:
    db.flush()
    relation = _conversation_access_statement(select(CommsConversation.id), [user.id]).subquery()
    return and_(
        CommsConversation.org_id == bound_organization_column(),
        CommsConversation.id.in_(select(relation.c.conversation_id).where(relation.c.level > 0)),
    )


def readable_conversation_ids(db: Session, user: User) -> set[UUID]:
    return set(
        db.scalars(
            select(CommsConversation.id).where(
                visible_conversation_clause(db, user),
            )
        )
    )


def conversation_reader_statement(
    conversation_ids: Select[tuple[UUID]],
    candidate_ids: Collection[UUID],
) -> Select[tuple[UUID]]:
    relation = _conversation_access_statement(conversation_ids, candidate_ids).subquery()
    return select(relation.c.user_id).where(relation.c.level > 0).distinct()


def organization_member_ids(db: Session) -> list[UUID]:
    """Active people of the bound organization: the only candidates for a channel reader.

    Returned as a list on purpose: a ``Select`` passed to the relation would correlate
    with its own ``User``/``Membership`` and silently change the result.
    """
    db.flush()
    return list(
        db.scalars(
            select(User.id)
            .join(Membership, bound_membership_join())
            .where(
                active_account_clause(),
            )
        )
    )


def conversation_reader_ids(db: Session, conversation: CommsConversation) -> set[UUID]:
    return set(
        db.scalars(
            conversation_reader_statement(
                select(CommsConversation.id).where(CommsConversation.id == conversation.id),
                organization_member_ids(db),
            )
        )
    )


def conversation_reader_counts(db: Session, conversation_ids: Collection[UUID]) -> dict[UUID, int]:
    """Readers per conversation in one grouped statement (D44 channel member counts).

    Evaluates the requested conversations times the bound organization's active people
    in the database (C x N), larger than one organization-wide event (N); slice 5 of
    the D44 spec measures it at sample-pack scale.
    """
    if not conversation_ids:
        return {}
    relation = _conversation_access_statement(
        select(CommsConversation.id).where(CommsConversation.id.in_(conversation_ids)),
        organization_member_ids(db),
    ).subquery()
    return {
        identity: count
        for identity, count in db.execute(
            select(relation.c.conversation_id, func.count(relation.c.user_id.distinct()))
            .where(relation.c.level > 0)
            .group_by(relation.c.conversation_id)
        ).tuples()
    }


def _blocked(db: Session, user_id: UUID, others: Collection[UUID]) -> bool:
    return (
        db.scalar(
            select(CommsDirectBlock.id)
            .where(
                CommsDirectBlock.org_id == bound_organization_column(),
                CommsDirectBlock.is_deleted.is_(False),
                or_(
                    and_(
                        CommsDirectBlock.user_id == user_id,
                        CommsDirectBlock.blocked_user_id.in_(others),
                    ),
                    and_(
                        CommsDirectBlock.blocked_user_id == user_id,
                        CommsDirectBlock.user_id.in_(others),
                    ),
                ),
            )
            .limit(1)
        )
        is not None
    )


def require_conversation_access(
    db: Session,
    user: User,
    conversation_id: UUID,
    level: ConversationLevel,
) -> CommsConversation:
    db.flush()
    conversation = db.scalar(
        select(CommsConversation)
        .where(
            CommsConversation.id == conversation_id,
            CommsConversation.org_id == bound_organization_column(),
            CommsConversation.is_deleted.is_(False),
            CommsConversation.deleted_at.is_(None),
        )
        .execution_options(populate_existing=True)
    )
    granted = explain_conversation_access(db, user, conversation_id).level
    if conversation is None or granted == "none":
        raise error("comms_not_found", "Conversation not found")
    if LEVELS.index(granted) < LEVELS.index(level):
        raise error(f"comms_{level}_denied", "Conversation access denied", 403)
    if level in ("post", "manage") and conversation.kind == "direct":
        peers = db.scalars(
            select(CommsMember.user_id).where(
                CommsMember.org_id == bound_organization_column(),
                CommsMember.conversation_id == conversation_id,
                CommsMember.is_deleted.is_(False),
                CommsMember.user_id != user.id,
            )
        ).all()
        if _blocked(db, user.id, peers):
            raise error("comms_post_denied", "Conversation access denied", 403)
    return conversation


def can_start_direct(db: Session, user: User, target_id: UUID) -> bool:
    return can_start_directs(db, user, [target_id])


def can_start_directs(db: Session, user: User, target_ids: Collection[UUID]) -> bool:
    # Both actual starts and bounded discovery consume this same set-form admission.
    from app.systems.comms.direct_admission import admitted_direct_ids

    ids = set(target_ids)
    return bool(ids) and admitted_direct_ids(db, user, ids) == ids
