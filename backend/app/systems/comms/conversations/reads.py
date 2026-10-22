"""Bounded page projections composed with the canonical S16 access relation."""

from collections import defaultdict
from collections.abc import Sequence
from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.orm import Session, aliased

from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database.organization_scope import bound_organization_column
from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.readers import active_account_clause
from app.systems.access.policy.scope import department_level_reader_statement
from app.systems.access.users.membership import bound_membership_join
from app.systems.access.users.models import Membership, User
from app.systems.comms.access import (
    LEVELS,
    _conversation_access_statement,
    conversation_reader_counts,
    conversation_reader_statement,
    error,
    organization_member_ids,
)
from app.systems.comms.conversations.models import (
    CommsCategory,
    CommsConversation,
    CommsConversationGroup,
    CommsDirectBlock,
    CommsMember,
)
from app.systems.comms.conversations.schemas import (
    BlockQuery,
    CategoryQuery,
    ConversationQuery,
    DirectBlockResponse,
    MemberQuery,
    MemberResponse,
    MemberSort,
    ResourceSort,
    TimeSort,
)
from app.systems.comms.messages.bootstrap import project_conversation
from app.systems.comms.messages.schemas import Category, Conversation
from app.systems.sandbox.departments.models import Department

CONVERSATION: TypeAdapter[Any] = TypeAdapter(Conversation)


def grants_for(
    db: Session, ids: Sequence[UUID], *, categories: bool = False
) -> dict[UUID, list[dict[str, Any]]]:
    grants: dict[UUID, list[dict[str, Any]]] = defaultdict(list)
    field = (
        CommsConversationGroup.category_id if categories else CommsConversationGroup.conversation_id
    )
    for row in db.scalars(
        select(CommsConversationGroup)
        .where(
            CommsConversationGroup.org_id == bound_organization_column(),
            field.in_(ids),
            CommsConversationGroup.is_deleted.is_(False),
        )
        .order_by(CommsConversationGroup.id)
    ):
        identity = row.category_id if categories else row.conversation_id
        assert identity is not None
        grants[identity].append(
            {
                "subject": row.subject,
                "level": row.level,
                **({"group_id": row.group_id} if row.subject == "group" else {}),
            }
        )
    return grants


def conversations(db: Session, user: User, rows: Sequence[CommsConversation]) -> list[Any]:
    ids = [row.id for row in rows]
    people: dict[UUID, dict[UUID, str]] = defaultdict(dict)
    for row in db.scalars(
        select(CommsMember).where(
            CommsMember.org_id == bound_organization_column(),
            CommsMember.conversation_id.in_(ids),
            CommsMember.is_deleted.is_(False),
            CommsMember.deleted_at.is_(None),
        )
    ):
        people[row.conversation_id][row.user_id] = row.role
    grants = grants_for(db, ids)
    readers = conversation_reader_counts(db, [row.id for row in rows if row.kind == "channel"])
    levels = {
        row.conversation_id: LEVELS[row.level]
        for row in db.execute(
            _conversation_access_statement(
                select(CommsConversation.id).where(CommsConversation.id.in_(ids)), [user.id]
            )
        )
    }
    return [
        CONVERSATION.validate_python(
            project_conversation(
                row,
                user.id,
                levels[row.id],
                people[row.id],
                grants[row.id],
                readers.get(row.id, 0),
            )
        )
        for row in rows
        if levels.get(row.id, "none") != "none"
    ]


def conversation(db: Session, user: User, row: CommsConversation) -> Any:
    values = conversations(db, user, [row])
    if not values:
        raise error("comms_not_found", "Conversation not found")
    return values[0]


def categories(db: Session, rows: Sequence[CommsCategory]) -> list[Category]:
    grants = grants_for(db, [row.id for row in rows], categories=True)
    return [
        Category.model_validate(
            {
                "id": row.id,
                "org_id": row.org_id,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
                "name": row.name,
                "position": row.position,
                "department_id": row.department_id,
                "default_access": grants[row.id],
            }
        )
        for row in rows
    ]


def category_page(db: Session, query: CategoryQuery) -> StandardListResponse[Category]:
    c = CommsCategory
    result = execute_standard_list(
        db,
        select(c).where(
            c.org_id == bound_organization_column(),
            c.is_deleted.is_(False),
            c.deleted_at.is_(None),
        ),
        query.standard(),
        ListQuerySpec(
            sort_fields={
                ResourceSort.NAME: c.name.expression,
                ResourceSort.POSITION: c.position.expression,
                ResourceSort.UPDATED: c.updated_at.expression,
            },
            default_sort=ResourceSort.POSITION,
            tie_breaker=c.id.expression,
            search_fields=(c.name.expression,),
        ),
    )
    return StandardListResponse(items=categories(db, result.items), pagination=result.pagination)


def conversation_page(
    db: Session, user: User, query: ConversationQuery
) -> StandardListResponse[Conversation]:
    c = CommsConversation
    policy = _conversation_access_statement(select(c.id), [user.id]).subquery()
    member = aliased(CommsMember)
    peer_name = (
        select(func.string_agg(User.display_name, " "))
        .join(
            member,
            member.user_id == User.id,
        )
        .where(
            member.org_id == bound_organization_column(),
            member.conversation_id == c.id,
            member.user_id != user.id,
            member.is_deleted.is_(False),
        )
        .correlate(c)
        .scalar_subquery()
    )
    name = func.coalesce(func.nullif(c.name, ""), peer_name, "")
    blocked = exists(
        select(CommsDirectBlock.id)
        .join(
            member,
            member.user_id == CommsDirectBlock.blocked_user_id,
        )
        .where(
            CommsDirectBlock.org_id == bound_organization_column(),
            CommsDirectBlock.user_id == user.id,
            CommsDirectBlock.is_deleted.is_(False),
            member.org_id == bound_organization_column(),
            member.conversation_id == c.id,
            member.is_deleted.is_(False),
        )
    ).correlate(c)
    result = execute_standard_list(
        db,
        select(c)
        .join(policy, policy.c.conversation_id == c.id)
        .where(
            c.org_id == bound_organization_column(),
            policy.c.level > 0,
            c.archived_at.is_not(None) if query.archived else c.archived_at.is_(None),
            or_(c.kind != "direct", ~blocked),
        ),
        query.standard(),
        ListQuerySpec(
            sort_fields={
                ResourceSort.NAME: name,
                ResourceSort.POSITION: c.position.expression,
                ResourceSort.UPDATED: c.updated_at.expression,
            },
            default_sort=ResourceSort.POSITION,
            tie_breaker=c.id.expression,
            search_fields=(name,),
        ),
    )
    return StandardListResponse(
        items=conversations(db, user, result.items), pagination=result.pagination
    )


def member_rows(db: Session, rows: Sequence[CommsMember]) -> list[MemberResponse]:
    ids = [row.user_id for row in rows]
    names = {
        identity: name
        for identity, name in db.execute(
            select(
                User.id,
                func.coalesce(func.nullif(User.display_name, ""), User.username),
            ).where(User.id.in_(ids))
        )
    }
    return _member_responses(
        db, [(row.user_id, names[row.user_id], row.role, row.joined_at) for row in rows]
    )


def _member_responses(
    db: Session, entries: Sequence[tuple[UUID, str, str, datetime]]
) -> list[MemberResponse]:
    ids = [entry[0] for entry in entries]
    departments: dict[UUID, list[dict[str, Any]]] = defaultdict(list)
    d = aliased(Department)
    readers = department_level_reader_statement(
        select(Department.id)
        .where(
            Department.org_id == bound_organization_column(),
            Department.id == d.id,
        )
        .correlate(d),
        AccessLevel.READ,
    )
    for person, identity, name in db.execute(
        select(User.id, d.id, d.department_name)
        .select_from(d)
        .join(
            User,
            User.id.in_(ids),
        )
        .where(
            d.org_id == bound_organization_column(), d.is_deleted.is_(False), User.id.in_(readers)
        )
        .order_by(d.id)
    ):
        departments[person].append({"id": identity, "name": name})
    return [
        MemberResponse.model_validate(
            {
                "user_id": person,
                "display_name": name,
                "member_role": role,
                "joined_at": joined_at,
                "departments": departments[person],
            }
        )
        for person, name, role, joined_at in entries
    ]


def member_page(
    db: Session, identity: UUID, query: MemberQuery
) -> StandardListResponse[MemberResponse]:
    conversation = db.get(CommsConversation, identity)
    if conversation is not None and conversation.kind == "channel":
        return _reader_page(db, conversation, query)
    m = CommsMember
    name = func.coalesce(func.nullif(User.display_name, ""), User.username)
    result = execute_standard_list(
        db,
        select(m)
        .join(User, User.id == m.user_id)
        .join(
            Membership,
            bound_membership_join(),
        )
        .where(
            m.org_id == bound_organization_column(),
            m.conversation_id == identity,
            m.is_deleted.is_(False),
            m.deleted_at.is_(None),
            active_account_clause(),
        ),
        StandardListRequest[MemberSort](**query.model_dump()),
        ListQuerySpec(
            sort_fields={MemberSort.NAME: name},
            default_sort=MemberSort.NAME,
            tie_breaker=User.id.expression,
            search_fields=(name,),
        ),
    )
    return StandardListResponse(items=member_rows(db, result.items), pagination=result.pagination)


def _reader_page(
    db: Session, conversation: CommsConversation, query: MemberQuery
) -> StandardListResponse[MemberResponse]:
    """D44: a channel lists its readers; a member row only adds a role and its join time."""
    name = func.coalesce(func.nullif(User.display_name, ""), User.username)
    readers = conversation_reader_statement(
        select(CommsConversation.id).where(CommsConversation.id == conversation.id),
        organization_member_ids(db),
    )
    result = execute_standard_list(
        db,
        select(User)
        .join(Membership, bound_membership_join())
        .where(User.id.in_(readers), active_account_clause()),
        StandardListRequest[MemberSort](**query.model_dump()),
        ListQuerySpec(
            sort_fields={MemberSort.NAME: name},
            default_sort=MemberSort.NAME,
            tie_breaker=User.id.expression,
            search_fields=(name,),
        ),
    )
    member = and_(
        CommsMember.org_id == Membership.org_id,
        CommsMember.conversation_id == conversation.id,
        CommsMember.user_id == Membership.user_id,
        CommsMember.is_deleted.is_(False),
        CommsMember.deleted_at.is_(None),
    )
    joined: dict[UUID, tuple[str, datetime]] = {
        person: (role or "member", joined_at or max(created, conversation.created_at))
        for person, created, role, joined_at in db.execute(
            select(
                Membership.user_id,
                Membership.created_at,
                CommsMember.role,
                CommsMember.joined_at,
            )
            .outerjoin(CommsMember, member)
            .where(
                Membership.org_id == bound_organization_column(),
                Membership.user_id.in_([user.id for user in result.items]),
                Membership.is_deleted.is_(False),
            )
        ).tuples()
    }
    entries = [
        (user.id, user.display_name or user.username, joined[user.id][0], joined[user.id][1])
        for user in result.items
    ]
    return StandardListResponse(items=_member_responses(db, entries), pagination=result.pagination)


def block_page(
    db: Session, user: User, query: BlockQuery
) -> StandardListResponse[DirectBlockResponse]:
    b = CommsDirectBlock
    result = execute_standard_list(
        db,
        select(b).where(
            b.org_id == bound_organization_column(),
            b.user_id == user.id,
            b.is_deleted.is_(False),
        ),
        StandardListRequest[TimeSort](**query.model_dump()),
        ListQuerySpec(
            sort_fields={
                TimeSort.CREATED: b.created_at.expression,
                TimeSort.UPDATED: b.updated_at.expression,
            },
            default_sort=TimeSort.CREATED,
            tie_breaker=b.blocked_user_id.expression,
        ),
    )
    return StandardListResponse(
        items=[DirectBlockResponse.model_validate(row) for row in result.items],
        pagination=result.pagination,
    )
