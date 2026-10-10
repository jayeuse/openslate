"""Current person visibility from the existing module, Board and group policies."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.models import AccessLevel, Group, GroupMember
from app.systems.access.policy.scope import allowed_module_ids
from app.systems.access.users.eligibility import is_active_account
from app.systems.access.users.models import User
from app.systems.boards.access import board_level
from app.systems.boards.models import Board
from app.systems.platform.files.access import error
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module


def visible_person(db: Session, actor: User, target_id: UUID) -> User:
    target = db.scalar(
        select(User).where(User.id == target_id).execution_options(populate_existing=True)
    )
    if target is None or not is_active_account(actor) or not is_active_account(target):
        raise error("person_not_found", "Person not found", 404)
    if actor.role == "admin":
        return target
    actor_modules = allowed_module_ids(db, actor, AccessLevel.READ)
    target_modules = allowed_module_ids(db, target, AccessLevel.READ)
    modules = (
        select(Module.id)
        .join(Department, Department.id == Module.department_id)
        .where(
            Module.is_deleted.is_(False),
            Department.is_deleted.is_(False),
        )
    )
    if actor_modules is not None:
        modules = modules.where(Module.id.in_(actor_modules))
    if target_modules is not None:
        modules = modules.where(Module.id.in_(target_modules))
    if db.scalar(modules.limit(1)) is not None:
        return target
    for board in db.scalars(
        select(Board).where(Board.is_deleted.is_(False), Board.deleted_at.is_(None))
    ):
        if board_level(db, actor, board) is not None and board_level(db, target, board) is not None:
            return target
    actor_groups = select(GroupMember.group_id).where(
        GroupMember.user_id == actor.id,
        GroupMember.is_deleted.is_(False),
    )
    shared = db.scalar(
        select(GroupMember.id)
        .join(Group, Group.id == GroupMember.group_id)
        .where(
            GroupMember.user_id == target.id,
            GroupMember.is_deleted.is_(False),
            Group.is_deleted.is_(False),
            GroupMember.group_id.in_(actor_groups),
        )
        .limit(1)
    )
    if shared is not None:
        return target
    raise error("person_not_found", "Person not found", 404)
