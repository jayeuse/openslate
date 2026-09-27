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
from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.scope import allowed_module_ids, effective_levels, includes
from app.systems.access.users.eligibility import is_active_account
from app.systems.access.users.models import User


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
        or session.expires_at <= utc_now()
    ):
        db.rollback()
        raise forbidden()


def require_fresh_module_access(
    db: Session,
    *,
    actor_id: UUID,
    session_id: UUID,
    module_id: UUID,
    level: AccessLevel,
) -> User:
    """Recheck the exact session, the account and the module level after long work.

    The account is reloaded so that a change of role, status or group made during
    the work applies.
    """

    require_live_session(db, actor_id=actor_id, session_id=session_id)
    timestamp = utc_now()
    try:
        actor = db.scalar(
            select(User)
            .where(User.id == actor_id)
            .execution_options(populate_existing=True)
            .with_for_update(of=User, read=True)
        )
        if not isinstance(actor, User) or not is_active_account(actor, now=timestamp):
            db.rollback()
            raise forbidden()
        granted = effective_levels(db, actor, now=timestamp).module_level(module_id)
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Authorization unavailable"
        ) from error
    if not includes(granted, level):
        db.rollback()
        raise forbidden()
    return actor
