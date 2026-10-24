"""Current bounded person visibility: modules, Boards, groups and Comms (D36), and profiles."""

from collections.abc import Collection
from uuid import UUID

from sqlalchemy import select, union
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.policy.models import AccessLevel, Group, GroupMember
from app.systems.access.policy.readers import active_account_clause
from app.systems.access.policy.scope import effective_levels, module_reader_statement
from app.systems.access.users.membership import bound_membership_join
from app.systems.access.users.models import Membership, User
from app.systems.boards.access import board_reader_statement, visible_board_clause
from app.systems.boards.models import Board
from app.systems.comms.access import (
    conversation_reader_statement,
    fresh_membership,
    visible_conversation_clause,
)
from app.systems.comms.conversations.models import CommsConversation
from app.systems.platform.files.access import error
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module


def visible_person_ids(db: Session, actor: User, candidate_ids: Collection[UUID]) -> set[UUID]:
    """Authorize only caller-bounded candidates; not an organization directory."""
    if not candidate_ids:
        return set()
    actor_membership = fresh_membership(db, actor)
    if actor_membership is None:
        return set()
    candidates = select(User.id).join(Membership, bound_membership_join()).where(
        User.id.in_(candidate_ids), active_account_clause(),
    )
    if actor_membership.role == "admin":
        return set(db.scalars(candidates))
    actor_modules = effective_levels(db, actor, membership=actor_membership).module_ids(
        AccessLevel.READ,
    )
    modules = (
        select(Module.id)
        .join(Department, Department.id == Module.department_id)
        .where(
            Module.org_id == bound_organization_column(),
            Department.org_id == bound_organization_column(),
            Module.is_deleted.is_(False),
            Department.is_deleted.is_(False),
        )
    )
    if actor_modules is not None:
        modules = modules.where(Module.id.in_(actor_modules))
    boards = (
        select(Board.id)
        .where(
            Board.is_deleted.is_(False),
            Board.deleted_at.is_(None),
            visible_board_clause(db, actor),
        )
    )
    actor_groups = select(GroupMember.group_id).where(
        GroupMember.user_id == actor.id,
        GroupMember.org_id == bound_organization_column(),
        GroupMember.is_deleted.is_(False),
    )
    shared = (
        select(GroupMember.user_id)
        .join(Group, Group.id == GroupMember.group_id)
        .where(
            GroupMember.user_id.in_(candidate_ids),
            GroupMember.org_id == bound_organization_column(),
            Group.org_id == bound_organization_column(),
            GroupMember.is_deleted.is_(False),
            Group.is_deleted.is_(False),
            GroupMember.group_id.in_(actor_groups),
        )
    )
    conversations = select(CommsConversation.id).where(visible_conversation_clause(db, actor))
    readers = union(
        module_reader_statement(modules).where(User.id.in_(candidate_ids)),
        board_reader_statement(boards).where(User.id.in_(candidate_ids)),
        shared,
        conversation_reader_statement(conversations, candidate_ids),
    )
    return set(db.scalars(candidates.where(User.id.in_(readers))))


def visible_person(db: Session, actor: User, target_id: UUID) -> User:
    if target_id in visible_person_ids(db, actor, [target_id]):
        target = db.scalar(select(User).where(User.id == target_id).execution_options(
            populate_existing=True,
        ))
        if target is not None:
            return target
    raise error("person_not_found", "Person not found", 404)


def profile_person(db: Session, actor: User, target_id: UUID) -> tuple[User, Membership, str]:
    """The person whose profile the actor may read, their membership, and the actor's role.

    Profiles (PD17): administrators and members see every active member of the bound
    organization; a guest keeps ``visible_person``; anyone reads their own profile.
    Every other case is the same 404 as the person card.
    """
    actor_membership = fresh_membership(db, actor)
    if actor_membership is None:
        raise error("person_not_found", "Person not found", 404)
    if actor_membership.role == "guest" and target_id != actor.id:
        visible_person(db, actor, target_id)
    row = db.execute(
        select(User, Membership)
        .join(Membership, bound_membership_join())
        .where(User.id == target_id, active_account_clause())
        .execution_options(populate_existing=True)
    ).first()
    if row is None:
        raise error("person_not_found", "Person not found", 404)
    return row[0], row[1], actor_membership.role
