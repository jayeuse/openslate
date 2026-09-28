"""Replace a group's members as an administrator or as a manager of every department it reaches.

The decision itself is :meth:`EffectiveAccess.manages_all` over :func:`group_reach`.
This module takes the row locks that keep that decision true until commit.

Lock order for a manager, chosen to match the existing writers (each of them
locks a group row first, then its member or access rows, then user rows):

1. The target group row, FOR UPDATE. ``replace_group_access`` starts with the
   same row, so the group's reach cannot change until this transaction ends.
2. The target group's live access rows, FOR UPDATE; they give the reach.
3. The manager's live memberships joined to those groups' live access rows,
   FOR SHARE. Removing the manager from a group, or changing or removing an
   access row that gives the manager authority, now waits for this transaction.
   The manager's own group rows are not locked: that would take a group lock
   after member rows, the reverse of ``replace_group_members``.
4. The manager's user row, FOR UPDATE, reloaded, so a change of role, status or
   expiry waits too. FOR UPDATE rather than FOR SHARE, because keeping the
   manager as a member locks the same row FOR UPDATE again later.

New rows can only add authority, so rows inserted after step 3 cannot make the
decision wrong.
"""

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies import require_fresh_exact_admin
from app.systems.access.policy.checks import forbidden
from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.access.policy.scope import effective_levels
from app.systems.access.policy.service import (
    commit,
    conflict,
    group_etag,
    lock_group,
    locked_access,
    replace_group_members,
    require_match,
    unavailable,
)
from app.systems.access.users.models import User, UserRole


def _deny(db: Session) -> HTTPException:
    db.rollback()
    return forbidden()


def _lock_manager_authority(db: Session, actor_id: UUID) -> User | None:
    """Steps 3 and 4 of the lock order; returns the reloaded manager."""

    db.execute(
        select(GroupMember.id, GroupAccess.id)
        .join(Group, Group.id == GroupMember.group_id)
        .join(GroupAccess, GroupAccess.group_id == Group.id)
        .where(
            GroupMember.user_id == actor_id,
            GroupMember.is_deleted.is_(False),
            Group.is_deleted.is_(False),
            GroupAccess.is_deleted.is_(False),
        )
        .order_by(GroupMember.id, GroupAccess.id)
        .with_for_update(of=(GroupMember, GroupAccess), read=True)
    ).all()
    manager = db.scalar(
        select(User)
        .where(User.id == actor_id)
        .execution_options(populate_existing=True)
        .with_for_update(of=User)
    )
    return manager if isinstance(manager, User) else None


def _lock_for_manager(db: Session, group_id: UUID, actor: User) -> Group:
    """Lock the group and the manager's authority, then require ``manage`` on its reach."""

    try:
        if not effective_levels(db, actor).managed_department_ids():
            raise _deny(db)
        row = lock_group(db, group_id)
        reach = frozenset(item.department_id for item in locked_access(db, row.id))
        manager = _lock_manager_authority(db, actor.id)
        if manager is None or not effective_levels(db, manager).manages_all(reach):
            raise _deny(db)
    except SQLAlchemyError as error:
        raise unavailable(db) from error
    return row


def replace_members(
    db: Session,
    group_id: UUID,
    member_ids: list[UUID],
    if_match: str | None,
    actor: User,
) -> Group:
    """Replace every member of one group under its current version.

    A refused manager gets 403 before the version check, so the answer does
    not reveal the group's revision.
    """

    if actor.role == UserRole.ADMIN.value:
        require_fresh_exact_admin(db, actor.id)
        row = lock_group(db, group_id)
    else:
        row = _lock_for_manager(db, group_id, actor)
    try:
        if row.is_deleted:
            raise conflict("Group is deleted")
        require_match(if_match, group_etag(row))
        if replace_group_members(db, row, member_ids, actor.id):
            row.revision += 1
            row.performed_by = actor.id
        commit(db, "Unable to change group members")
        db.refresh(row)
        return row
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as error:
        raise unavailable(db) from error
