"""The level of a user on a Board, from the Board scope and the access function.

1. An inactive account has no level. An administrator manages every Board.
2. Every active account reads the company Board; only administrators post on it.
3. A department Board follows the department: the level of the department row,
   or ``read`` when the user reads only some modules of the department. The same
   rule decides who receives the Board's notifications.
4. A project Board follows ``board_groups``: the highest level of the user's groups.
5. A guest is limited to ``read``.

``read`` lets a user see posts, events and tiles. ``write`` lets them add posts and
events and change their own. ``manage`` also lets them pin posts, change tiles and
change the posts and events of other users.
"""

from typing import Any
from uuid import UUID

from sqlalchemy import Select, and_, false, or_, select, true
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.core.base_model import utc_now
from app.systems.access.policy.models import AccessLevel, Group, GroupAccess, GroupMember
from app.systems.access.policy.scope import effective_levels, includes, rank
from app.systems.access.users.eligibility import established_user_clause, is_active_account
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.boards.models import Board, BoardGroup, BoardScope


def _capped(user: User, level: AccessLevel | None) -> AccessLevel | None:
    if level is not None and user.role == UserRole.GUEST.value:
        return AccessLevel.READ
    return level


def project_level(db: Session, user: User, board_id: UUID) -> AccessLevel | None:
    """The highest ``board_groups`` level of the user's live groups on one Board."""

    levels = db.scalars(
        select(BoardGroup.level)
        .join(Group, Group.id == BoardGroup.group_id)
        .join(GroupMember, GroupMember.group_id == Group.id)
        .where(
            BoardGroup.board_id == board_id,
            BoardGroup.is_deleted.is_(False),
            Group.is_deleted.is_(False),
            GroupMember.is_deleted.is_(False),
            GroupMember.user_id == user.id,
        )
    ).all()
    found = [AccessLevel(level) for level in levels]
    return max(found, key=rank) if found else None


def board_level(db: Session, user: User, board: Board) -> AccessLevel | None:
    """Return the user's level on the Board, or None when the user cannot read it."""

    if not is_active_account(user) or board.is_deleted or board.deleted_at is not None:
        return None
    if user.role == UserRole.ADMIN.value:
        return AccessLevel.MANAGE
    if board.scope == BoardScope.COMPANY.value:
        return AccessLevel.READ
    if board.scope == BoardScope.DEPARTMENT.value:
        if board.department_id is None:
            return None
        access = effective_levels(db, user)
        level = access.department_level(board.department_id)
        if level is None and board.department_id in access.module_departments.values():
            level = AccessLevel.READ
        return _capped(user, level)
    if board.scope == BoardScope.PROJECT.value:
        return _capped(user, project_level(db, user, board.id))
    return None


def has_level(db: Session, user: User, board: Board, required: AccessLevel) -> bool:
    return includes(board_level(db, user, board), required)


def visible_board_clause(user: User) -> ColumnElement[bool]:
    """SQL form of ``board_level(...) is not None`` over each ``boards`` row."""

    if not is_active_account(user):
        return false()
    if user.role == UserRole.ADMIN.value:
        return true()
    memberships = (
        select(GroupMember.group_id)
        .join(Group, Group.id == GroupMember.group_id)
        .where(
            GroupMember.user_id == user.id,
            GroupMember.is_deleted.is_(False),
            Group.is_deleted.is_(False),
        )
    )
    department_rows = select(GroupAccess.department_id).where(
        GroupAccess.group_id.in_(memberships), GroupAccess.is_deleted.is_(False)
    )
    project_rows = select(BoardGroup.board_id).where(
        BoardGroup.group_id.in_(memberships), BoardGroup.is_deleted.is_(False)
    )
    return or_(
        Board.scope == BoardScope.COMPANY.value,
        and_(
            Board.scope == BoardScope.DEPARTMENT.value,
            Board.department_id.in_(department_rows),
        ),
        and_(Board.scope == BoardScope.PROJECT.value, Board.id.in_(project_rows)),
    )


def _active_accounts() -> Select[tuple[UUID]]:
    timestamp = utc_now()
    return select(User.id).where(
        User.status == UserStatus.ACTIVE.value,
        User.is_deleted.is_(False),
        User.deleted_at.is_(None),
        or_(User.expires_at.is_(None), User.expires_at > timestamp),
        established_user_clause(),
    )


def board_reader_ids(db: Session, board: Board) -> frozenset[UUID]:
    """Every active account that can read the Board now, for notifications.

    This is the set of users for whom :func:`board_level` is not None.
    """

    if board.is_deleted or board.deleted_at is not None:
        return frozenset()
    admins: Any = User.role == UserRole.ADMIN.value
    statement = _active_accounts()
    if board.scope == BoardScope.COMPANY.value:
        return frozenset(db.scalars(statement).all())
    member_groups = (
        select(GroupMember.user_id)
        .join(Group, Group.id == GroupMember.group_id)
        .where(GroupMember.is_deleted.is_(False), Group.is_deleted.is_(False))
    )
    if board.scope == BoardScope.DEPARTMENT.value and board.department_id is not None:
        readers = member_groups.join(GroupAccess, GroupAccess.group_id == Group.id).where(
            GroupAccess.is_deleted.is_(False), GroupAccess.department_id == board.department_id
        )
    elif board.scope == BoardScope.PROJECT.value:
        readers = member_groups.join(BoardGroup, BoardGroup.group_id == Group.id).where(
            BoardGroup.is_deleted.is_(False), BoardGroup.board_id == board.id
        )
    else:
        return frozenset()
    return frozenset(db.scalars(statement.where(or_(admins, User.id.in_(readers)))).all())
