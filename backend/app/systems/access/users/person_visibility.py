"""Current bounded person visibility: modules, Boards, groups and Comms (D36)."""

from collections.abc import Collection
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import Select, select, union
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
from app.systems.comms.admissions.models import CommsAdmission
from app.systems.comms.capabilities import capability_check
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
    visible = set(db.scalars(candidates.where(User.id.in_(readers))))
    remaining = set(candidate_ids) - visible
    if remaining and actor_membership.role != "guest":
        visible |= _pending_admission_people(db, actor, candidates, remaining)
    return visible


def _pending_admission_people(
    db: Session, actor: User, candidates: Select[tuple[UUID]], remaining: set[UUID],
) -> set[UUID]:
    """People with a pending join request on a live channel the actor currently manages.

    Requests only: an invitation is created by a manager for any member, so it must
    not make that member visible.
    """
    pending: dict[UUID, set[UUID]] = {}
    for conversation_id, user_id in db.execute(
        select(CommsAdmission.conversation_id, CommsAdmission.user_id)
        .join(
            CommsConversation,
            (CommsConversation.org_id == CommsAdmission.org_id)
            & (CommsConversation.id == CommsAdmission.conversation_id),
        )
        .where(
            CommsAdmission.org_id == bound_organization_column(),
            CommsAdmission.user_id.in_(candidates.where(User.id.in_(remaining))),
            CommsAdmission.kind == "request",
            CommsAdmission.status == "pending",
            CommsAdmission.is_deleted.is_(False),
            CommsConversation.kind == "channel",
            CommsConversation.is_deleted.is_(False),
            CommsConversation.deleted_at.is_(None),
        )
    ):
        pending.setdefault(conversation_id, set()).add(user_id)
    found: set[UUID] = set()
    for conversation_id, people in pending.items():
        try:
            # The admissions router's own management predicate (manage_conversation).
            check = capability_check(db, actor, conversation_id)
        except HTTPException:
            continue
        if check["capabilities"]["manageChannel"]["allowed"]:
            found |= people
    return found


def visible_person(db: Session, actor: User, target_id: UUID) -> User:
    if target_id in visible_person_ids(db, actor, [target_id]):
        target = db.scalar(select(User).where(User.id == target_id).execution_options(
            populate_existing=True,
        ))
        if target is not None:
            return target
    raise error("person_not_found", "Person not found", 404)
