"""The one access function: a user's level on each department and module.

Rules, in order:

1. An administrator has ``manage`` everywhere.
2. A disabled, pending, expired or deleted account has nothing.
3. For each group of the user, the most specific ``group_access`` row for the
   target wins: the module row, or else the department row.
4. The highest level across all groups wins. Groups only add access.
5. A guest is limited to ``read``.
6. With no matching row, the user has no access.
7. ``manage`` on a department (a department row) also lets the user change the
   members of a group whose live rows all fall inside departments they manage.
   A group with no live rows is administrator-only.

Every read path takes its filter from :func:`allowed_module_ids` or
:func:`level_for`, so one rule decides who sees which records.
"""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import Select, and_, exists, false, or_, select, true
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.core.base_model import utc_now
from app.systems.access.identity.eligibility import is_identity_eligible
from app.systems.access.policy.models import AccessLevel, Group, GroupAccess, GroupMember
from app.systems.access.users.eligibility import (
    established_user_clause,
    is_active_account,
    is_established_user,
)
from app.systems.access.users.membership import sole_active_membership
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.sandbox.modules.models import Module

_RANK = {AccessLevel.READ: 1, AccessLevel.WRITE: 2, AccessLevel.MANAGE: 3}


def rank(level: AccessLevel | None) -> int:
    """Order levels so that a higher level includes every lower one."""

    return 0 if level is None else _RANK[level]


def includes(granted: AccessLevel | None, required: AccessLevel) -> bool:
    return rank(granted) >= rank(required)


def _highest(first: AccessLevel | None, second: AccessLevel) -> AccessLevel:
    if first is None or rank(second) > rank(first):
        return second
    return first


@dataclass(frozen=True, slots=True)
class EffectiveAccess:
    """One user's levels, resolved once from the database.

    ``unrestricted`` is true only for an active administrator. ``modules`` holds
    the level of every module the user can reach; ``departments`` holds the level
    of the department rows, which apply to the whole department.
    """

    unrestricted: bool = False
    modules: Mapping[UUID, AccessLevel] = field(default_factory=dict)
    module_departments: Mapping[UUID, UUID] = field(default_factory=dict)
    departments: Mapping[UUID, AccessLevel] = field(default_factory=dict)

    def module_level(self, module_id: UUID) -> AccessLevel | None:
        if self.unrestricted:
            return AccessLevel.MANAGE
        return self.modules.get(module_id)

    def department_level(self, department_id: UUID) -> AccessLevel | None:
        if self.unrestricted:
            return AccessLevel.MANAGE
        return self.departments.get(department_id)

    def module_ids(self, level: AccessLevel) -> frozenset[UUID] | None:
        if self.unrestricted:
            return None
        return frozenset(
            module_id for module_id, granted in self.modules.items() if includes(granted, level)
        )

    def department_ids(self) -> frozenset[UUID] | None:
        """Departments where the user can read something: a department row or a module."""

        if self.unrestricted:
            return None
        return frozenset(self.departments) | frozenset(self.module_departments.values())

    def managed_department_ids(self) -> frozenset[UUID] | None:
        """Departments where a department row gives ``manage``. None means every department."""

        if self.unrestricted:
            return None
        return frozenset(
            department_id
            for department_id, level in self.departments.items()
            if level == AccessLevel.MANAGE
        )

    def manages_all(self, department_ids: frozenset[UUID]) -> bool:
        """True when the user manages every department of a non-empty set.

        This decides who may change a group's members: pass the group's reach
        from :func:`group_reach`. An administrator manages every group.
        """

        managed = self.managed_department_ids()
        if managed is None:
            return True
        return bool(department_ids) and department_ids <= managed

    def entries(self) -> list[tuple[UUID, UUID | None, AccessLevel]]:
        """Compact levels for a client: department rows, then modules that differ.

        A client reads a module's level from its module entry, or else from its
        department entry. An administrator has no entries; the role says it all.
        """

        entries: list[tuple[UUID, UUID | None, AccessLevel]] = [
            (department_id, None, level)
            for department_id, level in sorted(self.departments.items(), key=lambda i: str(i[0]))
        ]
        for module_id, level in sorted(self.modules.items(), key=lambda item: str(item[0])):
            department_id = self.module_departments[module_id]
            if self.departments.get(department_id) != level:
                entries.append((department_id, module_id, level))
        return entries


NO_ACCESS = EffectiveAccess()


_GroupLevels = dict[UUID, dict[UUID, AccessLevel]]
# One live ``group_access`` row: group, department, module (None for a department row), level.
AccessRow = tuple[UUID, UUID, UUID | None, str]


@dataclass(frozen=True, slots=True)
class _Resolution:
    """The resolved levels and the raw rows of each group they came from."""

    access: EffectiveAccess
    department_rows: _GroupLevels = field(default_factory=dict)
    module_rows: _GroupLevels = field(default_factory=dict)
    guest: bool = False


def effective_levels(
    db: Session, user: User, *, now: datetime | None = None, membership: Membership | None = None
) -> EffectiveAccess:
    """Resolve the user's level on every department and module they can reach."""

    return _resolve(db, user, now=now, membership=membership).access


def _resolve(
    db: Session, user: User, *, now: datetime | None, membership: Membership | None = None
) -> _Resolution:
    """Rule 2 and the reads; :func:`_fold_access` applies the other rules."""

    # The temporary read-only bridge does not flush; resolve current transaction state first.
    db.flush()
    try:
        membership = membership or sole_active_membership(db, user.id)
    except HTTPException:
        return _Resolution(NO_ACCESS)
    if (membership.user_id != user.id or membership.status != "active"
            or user.status != UserStatus.ACTIVE.value or not is_established_user(membership)
            or not is_identity_eligible(user, membership, now=now)):
        return _Resolution(NO_ACCESS)
    role = membership.role
    if role == UserRole.ADMIN.value:
        return _fold_access(role, (), {})
    rows: list[AccessRow] = list(
        db.execute(
            select(
                GroupAccess.group_id,
                GroupAccess.department_id,
                GroupAccess.module_id,
                GroupAccess.level,
            )
            .join(GroupMember, GroupMember.group_id == GroupAccess.group_id)
            .join(Group, Group.id == GroupAccess.group_id)
            .where(
                GroupMember.user_id == user.id,
                GroupMember.org_id == membership.org_id,
                Group.org_id == membership.org_id,
                GroupAccess.org_id == membership.org_id,
                GroupMember.is_deleted.is_(False),
                Group.is_deleted.is_(False),
                GroupAccess.is_deleted.is_(False),
            )
        ).tuples()
    )
    if not rows:
        return _Resolution(NO_ACCESS)
    department_ids = {row[1] for row in rows if row[2] is None}
    module_ids = {row[2] for row in rows if row[2] is not None}
    module_departments = {
        module_id: department_id
        for module_id, department_id in db.execute(
            select(Module.id, Module.department_id).where(
                Module.org_id == membership.org_id,
                or_(Module.department_id.in_(department_ids), Module.id.in_(module_ids))
            )
        ).tuples()
    }
    return _fold_access(role, rows, module_departments)


def _fold_access(
    role: str, rows: Iterable[AccessRow], module_departments: Mapping[UUID, UUID]
) -> _Resolution:
    """Apply rules 1 and 3 to 6 to an active account's live rows, with no database.

    ``module_departments`` maps every module that the rows reach (each module of a
    department row, and each module row's module) to its current department. This is
    not an access check: it skips rule 2, so only :func:`_resolve` calls it.
    """

    if role == UserRole.ADMIN.value:
        return _Resolution(EffectiveAccess(unrestricted=True))
    department_rows: _GroupLevels = {}
    module_rows: _GroupLevels = {}
    for group_id, department_id, module_id, raw_level in rows:
        level = AccessLevel(raw_level)
        if module_id is None:
            department_rows.setdefault(group_id, {})[department_id] = level
        else:
            module_rows.setdefault(group_id, {})[module_id] = level
    guest = role == UserRole.GUEST.value
    modules: dict[UUID, AccessLevel] = {}
    for group_id in department_rows.keys() | module_rows.keys():
        group_departments = department_rows.get(group_id, {})
        group_modules = module_rows.get(group_id, {})
        for module_id, department_id in module_departments.items():
            specific = group_modules.get(module_id) or group_departments.get(department_id)
            if specific is not None:
                modules[module_id] = _highest(modules.get(module_id), specific)
    departments: dict[UUID, AccessLevel] = {}
    for group_departments in department_rows.values():
        for department_id, level in group_departments.items():
            departments[department_id] = _highest(departments.get(department_id), level)
    if guest:
        modules = {key: AccessLevel.READ for key in modules}
        departments = {key: AccessLevel.READ for key in departments}
    access = EffectiveAccess(
        modules=modules,
        module_departments={key: module_departments[key] for key in modules},
        departments=departments,
    )
    return _Resolution(access, department_rows, module_rows, guest)


@dataclass(frozen=True, slots=True)
class AccessSource:
    """One compact entry and every group whose own row produces its level.

    ``groups`` holds ``(group_id, name, level)`` with the group's own row level,
    which for a guest can be higher than the capped entry level.
    """

    department_id: UUID
    module_id: UUID | None
    level: AccessLevel
    groups: tuple[tuple[UUID, str, AccessLevel], ...]


def explain_access(
    db: Session, user: User, *, now: datetime | None = None
) -> tuple[EffectiveAccess, list[AccessSource]]:
    """Return :meth:`EffectiveAccess.entries` with the groups behind each one.

    A group produces an entry when its most specific row for the target, capped
    for a guest, equals the entry level. Entries sort by department, then module.
    """

    resolution = _resolve(db, user, now=now)
    access = resolution.access
    found: list[tuple[UUID, UUID | None, AccessLevel, list[tuple[UUID, AccessLevel]]]] = []
    for department_id, module_id, level in access.entries():
        sources: list[tuple[UUID, AccessLevel]] = []
        for group_id in resolution.department_rows.keys() | resolution.module_rows.keys():
            own = resolution.department_rows.get(group_id, {}).get(department_id)
            if module_id is not None:
                own = resolution.module_rows.get(group_id, {}).get(module_id) or own
            capped = AccessLevel.READ if resolution.guest and own is not None else own
            if capped == level and own is not None:
                sources.append((group_id, own))
        found.append((department_id, module_id, level, sources))
    group_ids = {group_id for *_, sources in found for group_id, _ in sources}
    names = dict(
        db.execute(select(Group.id, Group.name).where(Group.id.in_(group_ids))).tuples().all()
        if group_ids
        else ()
    )
    explained = [
        AccessSource(
            department_id,
            module_id,
            level,
            tuple(
                sorted(
                    ((group_id, names[group_id], own) for group_id, own in sources),
                    key=lambda item: (item[1], item[0]),
                )
            ),
        )
        for department_id, module_id, level, sources in found
    ]
    explained.sort(
        key=lambda item: (
            item.department_id,
            item.module_id is not None,
            item.module_id or UUID(int=0),
        )
    )
    return access, explained


def allowed_module_ids(
    db: Session, user: User, level: AccessLevel, *, now: datetime | None = None
) -> frozenset[UUID] | None:
    """Return the modules where the user has at least ``level``.

    None means every module: the user is an active administrator. Callers turn
    the result into a query filter; an empty set denies everything.
    """

    return effective_levels(db, user, now=now).module_ids(level)


def level_for(
    db: Session,
    user: User,
    department_id: UUID,
    module_id: UUID | None = None,
    *,
    now: datetime | None = None,
) -> AccessLevel | None:
    """Return the user's level on a module, or on the whole department when no module is given."""

    access = effective_levels(db, user, now=now)
    if module_id is None:
        return access.department_level(department_id)
    if not access.unrestricted and access.module_departments.get(module_id) != department_id:
        return None
    return access.module_level(module_id)


def group_reach(db: Session, group_id: UUID) -> frozenset[UUID]:
    """Departments that the group's live access rows reach.

    A module row carries its own department, so it counts as that department.
    """

    return frozenset(
        db.scalars(
            select(GroupAccess.department_id).where(
                GroupAccess.group_id == group_id, GroupAccess.is_deleted.is_(False)
            )
        ).all()
    )


def manageable_group_clause(access: EffectiveAccess) -> ColumnElement[bool]:
    """SQL form of :meth:`EffectiveAccess.manages_all` over each ``groups`` row."""

    managed = access.managed_department_ids()
    if managed is None:
        return true()
    if not managed:
        return false()
    live = and_(GroupAccess.group_id == Group.id, GroupAccess.is_deleted.is_(False))
    return and_(
        exists(select(GroupAccess.id).where(live)),
        ~exists(
            select(GroupAccess.id).where(live, GroupAccess.department_id.not_in(sorted(managed)))
        ),
    )


def _active_account_clause(now: datetime | None) -> ColumnElement[bool]:
    timestamp = now or utc_now()
    return and_(
        User.status == UserStatus.ACTIVE.value,
        User.is_deleted.is_(False),
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
    return select(User.id).join(Membership, Membership.user_id == User.id).where(
        _active_account_clause(now),
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

    if not is_active_account(db, user):
        return false()
    if sole_active_membership(db, user.id).role == UserRole.ADMIN.value:
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
