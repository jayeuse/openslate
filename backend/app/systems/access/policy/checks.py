"""Route-facing checks built on the access function in :mod:`scope`.

A module the user cannot read is hidden: the check answers 404, the same as a
missing module. A module the user can read but not change answers 403.
"""

from typing import Any
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import false, select, true
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.core.base_model import utc_now
from app.systems.access.identity.models import IdentitySession
from app.systems.access.policy.models import AccessLevel, Group, GroupAccess, GroupMember
from app.systems.access.policy.scope import allowed_module_ids, effective_levels, includes
from app.systems.access.users.eligibility import is_active_account
from app.systems.access.users.models import User
from app.systems.manage.workspace.security_policy import (
    effective_session_expiry,
    load_workspace_policy,
)


def module_hidden() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Module not found")


def forbidden() -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


def require_module_access(db: Session, user: User, module_id: UUID, level: AccessLevel) -> None:
    """Require ``level`` on one module: 404 when it is hidden, 403 when it is read-only."""

    granted = effective_levels(db, user).module_level(module_id)
    if granted is None:
        raise module_hidden()
    if not includes(granted, level):
        raise forbidden()


def module_level(db: Session, user: User, module_id: UUID) -> AccessLevel | None:
    return effective_levels(db, user).module_level(module_id)


def can_read_module(db: Session, user: User, module_id: UUID) -> bool:
    return module_level(db, user, module_id) is not None


def module_filter(
    db: Session, user: User, level: AccessLevel, column: ColumnElement[Any] | Any
) -> ColumnElement[bool]:
    """Turn the allowed modules into a SQL condition on a module ID column."""

    module_ids = allowed_module_ids(db, user, level)
    if module_ids is None:
        return true()
    if not module_ids:
        return false()
    return column.in_(sorted(module_ids))


def department_filter(
    db: Session, user: User, column: ColumnElement[Any] | Any
) -> ColumnElement[bool]:
    """Departments where the user can read something."""

    department_ids = effective_levels(db, user).department_ids()
    if department_ids is None:
        return true()
    if not department_ids:
        return false()
    return column.in_(sorted(department_ids))


def require_live_session(db: Session, *, actor_id: UUID, session_id: UUID) -> None:
    """Lock the exact session and require that it still belongs to the actor and is live.

    The lock orders this check before or after a concurrent revocation.
    """

    try:
        session = db.get(IdentitySession, session_id, with_for_update=True, populate_existing=True)
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Authorization unavailable"
        ) from error
    if (
        session is None
        or session.user_id != actor_id
        or session.revoked_at is not None
        or effective_session_expiry(session, load_workspace_policy(db)) <= utc_now()
    ):
        db.rollback()
        raise forbidden()


def _lock_authority(db: Session, actor_id: UUID) -> User | None:
    """Lock every row that gives a member or guest their levels, then reload the user.

    Lock order, chosen to match every writer of these rows (each locks group
    rows first, in ID order, then member or access rows, then user rows, then
    sessions):

    1. The actor's live groups, FOR SHARE, in ID order. ``replace_group_access``,
       ``replace_group_members``, group deletion, invitations and promotion to
       administrator all start by locking these rows FOR UPDATE, so each of them
       waits for this transaction. Unlike ``delegation.py``, this path holds no
       earlier group or member lock, so taking the group rows first keeps it in
       the writers' order; a members-first order would invert against promotion,
       which locks the user row before the memberships it removes.
    2. The actor's live memberships joined to those groups' live access rows,
       FOR SHARE (step 3 of ``delegation.py``).
    3. The user row, FOR SHARE, reloaded, so a change of role, status or expiry
       waits too.

    A group joined after step 1 can only add access, so it cannot make the
    decision wrong. The Sandbox publish locks the live groups FOR SHARE, then the
    module access rows FOR UPDATE, before any structure row.
    """

    group_ids = db.scalars(
        select(GroupMember.group_id)
        .join(Group, Group.id == GroupMember.group_id)
        .where(
            GroupMember.user_id == actor_id,
            GroupMember.is_deleted.is_(False),
            Group.is_deleted.is_(False),
        )
    ).all()
    if group_ids:
        db.execute(
            select(Group.id)
            .where(Group.id.in_(sorted(set(group_ids))))
            .order_by(Group.id)
            .with_for_update(read=True)
        ).all()
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
    actor = db.scalar(
        select(User)
        .where(User.id == actor_id)
        .execution_options(populate_existing=True)
        .with_for_update(of=User, read=True)
    )
    return actor if isinstance(actor, User) else None


def require_fresh_module_access(
    db: Session,
    *,
    actor_id: UUID,
    session_id: UUID,
    module_id: UUID,
    level: AccessLevel,
) -> User:
    """Recheck the account, the module level and the exact session after long work.

    The account and the rows that give its level are locked until the caller
    commits (see :func:`_lock_authority`), so a concurrent revocation either
    waits for the protected output to commit or commits first and this check
    fails. The session is locked last because writers that revoke sessions,
    such as disabling a user, lock the user row first.
    """

    timestamp = utc_now()
    try:
        actor = _lock_authority(db, actor_id)
        if actor is None or not is_active_account(actor, now=timestamp):
            db.rollback()
            raise forbidden()
        granted = effective_levels(db, actor, now=timestamp).module_level(module_id)
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Authorization unavailable"
        ) from error
    require_live_session(db, actor_id=actor_id, session_id=session_id)
    if not includes(granted, level):
        db.rollback()
        raise forbidden()
    return actor
