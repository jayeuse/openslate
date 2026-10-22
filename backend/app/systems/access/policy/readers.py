"""Canonical reader projections; scope.py retains their public import paths."""

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import Select, and_, exists, false, or_, select, true
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.systems.access.policy.models import AccessLevel, Group, GroupAccess, GroupMember
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.membership import bound_membership_join, current_membership
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module


def active_account_clause(now: datetime | None = None) -> ColumnElement[bool]:
    timestamp = now or utc_now()
    return and_(
        User.status == UserStatus.ACTIVE.value,
        User.is_deleted.is_(False),
        Membership.org_id == bound_organization_column(),
        Membership.status == UserStatus.ACTIVE.value,
        Membership.is_deleted.is_(False),
        or_(Membership.expires_at.is_(None), Membership.expires_at > timestamp),
        established_user_clause(),
    )


def _readers(access_target: ColumnElement[bool], now: datetime | None) -> Select[tuple[UUID]]:
    """Active administrators, and active users with a live row that matches the target.

    Every level includes ``read`` and the most specific row never goes below it,
    so any matching row gives read access.
    """

    group_readers = (
        select(GroupMember.user_id)
        .join(Group, Group.id == GroupMember.group_id)
        .join(GroupAccess, GroupAccess.group_id == Group.id)
        .where(
            GroupMember.is_deleted.is_(False),
            Group.is_deleted.is_(False),
            GroupAccess.is_deleted.is_(False),
            access_target,
        )
    )
    return select(User.id).join(Membership, bound_membership_join()).where(
        active_account_clause(now),
        or_(Membership.role == UserRole.ADMIN.value, User.id.in_(group_readers)),
    )


def module_reader_ids(
    db: Session, module_id: UUID, *, now: datetime | None = None
) -> frozenset[UUID]:
    """Every active user who can read the module now."""

    department_id = db.scalar(select(Module.department_id).where(Module.id == module_id))
    if department_id is None:
        return frozenset()
    target = and_(
        GroupAccess.department_id == department_id,
        or_(GroupAccess.module_id.is_(None), GroupAccess.module_id == module_id),
    )
    return frozenset(db.scalars(_readers(target, now)).all())


def module_reader_statement(
    module_ids: Select[tuple[UUID]], *, now: datetime | None = None
) -> Select[tuple[UUID]]:
    """Active readers of any module in a caller-scoped module query, in one statement.

    An empty module query has no readers, including administrators. The caller
    owns module visibility/lifecycle filters; reader eligibility and group access
    remain the same canonical rules as :func:`module_reader_ids`.
    """

    target = exists(
        select(Module.id)
        .where(
            Module.id.in_(module_ids),
            GroupAccess.department_id == Module.department_id,
            or_(GroupAccess.module_id.is_(None), GroupAccess.module_id == Module.id),
        )
        .correlate(GroupAccess)
    )
    return _readers(target, now).where(module_ids.exists().correlate(None))


def department_reader_ids(
    db: Session, department_id: UUID, *, now: datetime | None = None
) -> frozenset[UUID]:
    """Every active user who can read something in the department now."""

    target = GroupAccess.department_id == department_id
    return frozenset(db.scalars(_readers(target, now)).all())


def department_reader_clause(db: Session, user: User, department_id: Any) -> ColumnElement[bool]:
    """SQL test that ``user`` can read something in the department named by a column.

    It replaces department membership for Board audiences: an administrator reads
    every department, and a member or guest needs a live group row there.
    """

    membership = current_membership(db, user)
    if membership is None:
        return false()
    if membership.role == UserRole.ADMIN.value:
        return true()
    return exists(
        select(GroupAccess.id)
        .join(Group, Group.id == GroupAccess.group_id)
        .join(GroupMember, GroupMember.group_id == Group.id)
        .where(
            GroupMember.user_id == user.id,
            GroupMember.is_deleted.is_(False),
            Group.is_deleted.is_(False),
            GroupAccess.is_deleted.is_(False),
            GroupAccess.department_id == department_id,
        )
    )


_DEPARTMENT_LEVELS = {
    AccessLevel.READ: ("read", "write", "manage"),
    AccessLevel.WRITE: ("write", "manage"),
    AccessLevel.MANAGE: ("manage",),
}


def department_level_reader_statement(
    department_ids: Select[tuple[UUID]], minimum: AccessLevel, *, now: datetime | None = None,
) -> Select[tuple[UUID]]:
    """Exact department authority, not Boards' broader module reach.

    Department rows have no more-specific department override. The maximum across
    groups meets a minimum iff a live department row meets it. Guests only read.
    The caller supplies scoped department IDs, possibly correlated to its resource.
    """
    levels = _DEPARTMENT_LEVELS[minimum]
    target = and_(
        GroupAccess.org_id == bound_organization_column(),
        Group.org_id == bound_organization_column(),
        GroupMember.org_id == bound_organization_column(),
        GroupAccess.module_id.is_(None), GroupAccess.department_id.in_(department_ids),
        GroupAccess.level.in_(levels),
    )
    statement = _readers(target, now).where(department_ids.exists()).correlate(None)
    if minimum != AccessLevel.READ:
        statement = statement.where(Membership.role != UserRole.GUEST.value)
    return statement


def department_level_clause(
    user_id: ColumnElement[UUID],
    role: ColumnElement[str],
    department_id: ColumnElement[UUID | None],
    minimum: AccessLevel,
) -> ColumnElement[bool]:
    """Per-person form of :func:`department_level_reader_statement` for one department.

    For a person whose ``users``/``memberships`` row the caller already limits with
    :func:`active_account_clause` in the bound organization, it is true exactly when
    that person is in ``department_level_reader_statement(<that department>, minimum)``:
    the department is live in the bound organization, and the person is an
    administrator or has a live department row there at ``minimum`` or above through a
    live group; a guest meets only ``read``. It reads only this person's group rows, so
    a caller that tests many (resource, person) pairs does not rescan every account.
    """
    org = bound_organization_column()
    live_department = exists(
        select(Department.id).where(
            Department.org_id == org,
            Department.is_deleted.is_(False),
            Department.id == department_id,
        )
    ).correlate_except(Department)
    department_row = exists(
        select(GroupAccess.id)
        .join(Group, Group.id == GroupAccess.group_id)
        .join(GroupMember, GroupMember.group_id == Group.id)
        .where(
            GroupMember.user_id == user_id,
            GroupMember.org_id == org,
            Group.org_id == org,
            GroupAccess.org_id == org,
            GroupMember.is_deleted.is_(False),
            Group.is_deleted.is_(False),
            GroupAccess.is_deleted.is_(False),
            GroupAccess.module_id.is_(None),
            GroupAccess.department_id == department_id,
            GroupAccess.level.in_(_DEPARTMENT_LEVELS[minimum]),
        )
    ).correlate_except(GroupAccess, Group, GroupMember)
    clause = and_(live_department, or_(role == UserRole.ADMIN.value, department_row))
    if minimum != AccessLevel.READ:
        clause = and_(clause, role != UserRole.GUEST.value)
    return clause
