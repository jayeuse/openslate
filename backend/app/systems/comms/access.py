"""Current Comms access: one bounded relation, four projections, no cached grants."""

from collections.abc import Collection
from dataclasses import dataclass
from typing import Any, Literal, cast
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import Select, and_, case, func, or_, select, true
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.policy.models import AccessLevel, Group, GroupMember
from app.systems.access.policy.readers import active_account_clause
from app.systems.access.policy.scope import department_level_reader_statement
from app.systems.access.users.membership import (
    bound_membership_join,
    current_membership,
    organization_membership,
)
from app.systems.access.users.models import Membership, User
from app.systems.comms.conversations.models import (
    CommsCategory,
    CommsConversation,
    CommsConversationGroup,
    CommsDirectBlock,
    CommsMember,
)
from app.systems.sandbox.departments.models import Department

ConversationLevel = Literal["none", "read", "post", "manage"]
ManagerSource = Literal["creator", "membership_manager", "department_manager"]
LEVELS: tuple[ConversationLevel, ...] = ("none", "read", "post", "manage")


def error(code: str, message: str, status: int = 404) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def fresh_membership(db: Session, user: User) -> Membership | None:
    """Flush pending writes before refreshing both account and organization authority."""
    db.flush()
    current = db.scalar(select(User).where(User.id == user.id).execution_options(
        populate_existing=True,
    ))
    membership = organization_membership(db, user.id, fresh=True)
    if current is None or membership is None:
        return None
    return current_membership(db, current)


def _conversation_access_statement(
    conversation_ids: Select[tuple[UUID]], user_ids: Collection[UUID],
) -> Select[Any]:
    """Select only requested person/resource pairs; never materialize an org-wide matrix.

    The relation includes zero levels for explanations. Every public projection
    below reads it; D36 composes the same reader projection rather than another policy.
    """
    c, category, member = CommsConversation, CommsCategory, CommsMember
    membership_role = select(member.role).where(
        member.org_id == bound_organization_column(), member.conversation_id == c.id,
        member.user_id == User.id, member.is_deleted.is_(False), member.deleted_at.is_(None),
    ).correlate(c, User).scalar_subquery()
    departments = select(Department.id).where(
        Department.org_id == bound_organization_column(), Department.is_deleted.is_(False),
        Department.id == func.coalesce(c.department_id, category.department_id),
    ).correlate(c, category)
    manages_department = User.id.in_(department_level_reader_statement(
        departments, AccessLevel.MANAGE,
    ))
    manager = case(
        (c.created_by == User.id, "creator"),
        (membership_role == "manager", "membership_manager"),
        (manages_department, "department_manager"),
        else_=None,
    )
    groups = select(GroupMember.group_id).join(Group, Group.id == GroupMember.group_id).where(
        GroupMember.org_id == bound_organization_column(),
        Group.org_id == bound_organization_column(), GroupMember.user_id == User.id,
        GroupMember.is_deleted.is_(False), Group.is_deleted.is_(False),
    ).correlate(User)
    grant = CommsConversationGroup
    best_grant = select(grant.level, grant.group_id, Group.name.label("group_name")).outerjoin(
        Group, Group.id == grant.group_id,
    ).where(
        grant.org_id == bound_organization_column(), grant.conversation_id == c.id,
        grant.category_id.is_(None), grant.is_deleted.is_(False),
        or_(grant.subject == "everyone", and_(
            grant.subject == "group", grant.group_id.in_(groups),
            Group.org_id == bound_organization_column(), Group.is_deleted.is_(False),
        )),
    ).order_by((grant.level == "post").desc(), grant.group_id.asc().nulls_last()).limit(1)
    granted = best_grant.correlate(c, User).lateral("comms_grant")
    department_level = case(
        (User.id.in_(department_level_reader_statement(departments, AccessLevel.WRITE)), 2),
        (User.id.in_(department_level_reader_statement(departments, AccessLevel.READ)), 1),
        else_=0,
    )
    ordinary = case(
        (c.scope == "organization", 2),
        (c.scope == "department", department_level),
        (c.scope == "groups", case(
            (granted.c.level == "post", 2), (granted.c.level == "read", 1), else_=0,
        )),
        (and_(c.scope == "members", membership_role.is_not(None)), 2),
        else_=0,
    )
    uncapped = case(
        (Membership.role == "admin", 3), (manager.is_not(None), 3), else_=ordinary,
    )
    level = case((Membership.role == "guest", func.least(uncapped, 1)), else_=uncapped)
    return select(
        c.id.label("conversation_id"), User.id.label("user_id"), level.label("level"),
        Membership.role.label("role"), manager.label("manager"), c.scope,
        c.department_id, granted.c.group_id, granted.c.group_name,
    ).select_from(c).outerjoin(category, and_(
        category.id == c.category_id, category.org_id == bound_organization_column(),
        category.is_deleted.is_(False), category.deleted_at.is_(None),
    )).join(User, User.id.in_(user_ids)).join(Membership, bound_membership_join()).outerjoin(
        granted, true(),
    ).where(
        c.org_id == bound_organization_column(), c.id.in_(conversation_ids),
        c.is_deleted.is_(False), c.deleted_at.is_(None), active_account_clause(),
    )


@dataclass(frozen=True)
class ConversationAccess:
    level: ConversationLevel
    manager_source: ManagerSource | None
    source: dict[str, Any]


def explain_conversation_access(
    db: Session, user: User, conversation_id: UUID,
) -> ConversationAccess:
    membership = fresh_membership(db, user)
    none = ConversationAccess("none", None, {
        "kind": "none", "reason": "no_access" if membership else "inactive_membership",
    })
    if membership is None:
        return none
    row = db.execute(_conversation_access_statement(
        select(CommsConversation.id).where(CommsConversation.id == conversation_id), [user.id],
    )).mappings().first()
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
    elif row["scope"] == "department":
        source = {"kind": "department", "department_id": row["department_id"]}
    elif row["scope"] == "groups" and row["group_id"] is not None:
        source = {"kind": "group", "group_id": row["group_id"], "group_name": row["group_name"]}
    elif row["scope"] in ("organization", "groups"):
        source = {"kind": "organization"}
    else:
        source = {"kind": "membership"}
    return ConversationAccess(level, manager, source)


def conversation_level(
    db: Session, user: User, conversation: CommsConversation,
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
    return set(db.scalars(select(CommsConversation.id).where(
        visible_conversation_clause(db, user),
    )))


def conversation_reader_statement(
    conversation_ids: Select[tuple[UUID]], candidate_ids: Collection[UUID],
) -> Select[tuple[UUID]]:
    relation = _conversation_access_statement(conversation_ids, candidate_ids).subquery()
    return select(relation.c.user_id).where(relation.c.level > 0).distinct()


def conversation_reader_ids(db: Session, conversation: CommsConversation) -> set[UUID]:
    db.flush()
    candidates = db.scalars(select(User.id).join(Membership, bound_membership_join()).where(
        active_account_clause(),
    )).all()
    return set(db.scalars(conversation_reader_statement(
        select(CommsConversation.id).where(CommsConversation.id == conversation.id), candidates,
    )))


def _blocked(db: Session, user_id: UUID, others: Collection[UUID]) -> bool:
    return db.scalar(select(CommsDirectBlock.id).where(
        CommsDirectBlock.org_id == bound_organization_column(),
        CommsDirectBlock.is_deleted.is_(False),
        or_(
            and_(CommsDirectBlock.user_id == user_id, CommsDirectBlock.blocked_user_id.in_(others)),
            and_(CommsDirectBlock.blocked_user_id == user_id, CommsDirectBlock.user_id.in_(others)),
        ),
    ).limit(1)) is not None


def require_conversation_access(
    db: Session, user: User, conversation_id: UUID, level: ConversationLevel,
) -> CommsConversation:
    db.flush()
    conversation = db.scalar(select(CommsConversation).where(
        CommsConversation.id == conversation_id,
        CommsConversation.org_id == bound_organization_column(),
        CommsConversation.is_deleted.is_(False), CommsConversation.deleted_at.is_(None),
    ).execution_options(populate_existing=True))
    granted = explain_conversation_access(db, user, conversation_id).level
    if conversation is None or granted == "none":
        raise error("comms_not_found", "Conversation not found")
    if LEVELS.index(granted) < LEVELS.index(level):
        raise error(f"comms_{level}_denied", "Conversation access denied", 403)
    if level in ("post", "manage") and conversation.kind == "direct":
        peers = db.scalars(select(CommsMember.user_id).where(
            CommsMember.org_id == bound_organization_column(),
            CommsMember.conversation_id == conversation_id, CommsMember.is_deleted.is_(False),
            CommsMember.user_id != user.id,
        )).all()
        if _blocked(db, user.id, peers):
            raise error("comms_post_denied", "Direct conversation is blocked", 403)
    return conversation


def can_start_direct(db: Session, user: User, target_id: UUID) -> bool:
    # This leaf may consume D36; readability never invokes direct-start admission.
    from app.systems.access.users.person_visibility import visible_person_ids
    from app.systems.comms.settings.resolution import resolve_settings

    membership = fresh_membership(db, user)
    if membership is None or membership.role == "guest" or target_id == user.id:
        return False
    target = db.scalar(select(User.id).join(Membership, bound_membership_join()).where(
        User.id == target_id, active_account_clause(), Membership.role != "guest",
    ))
    if target is None:
        return False
    if target_id not in visible_person_ids(db, user, [target_id]) or _blocked(
        db, user.id, [target_id],
    ):
        return False
    rule = resolve_settings(db, {"kind": "workspace"})["dm_rule"]
    if rule == "everyone":
        return True
    if rule == "none":
        return False
    channels = select(CommsConversation.id).where(
        CommsConversation.kind == "channel", visible_conversation_clause(db, user),
    )
    return db.scalar(conversation_reader_statement(channels, [target_id]).limit(1)) is not None
