"""Memberships of the organization bound to the current transaction.

Every request and worker transaction is bound to one organization (see
``app.core.database.organization_scope``). Authorization reads the actor's
membership in that organization; a membership elsewhere grants nothing here.
"""

from datetime import datetime
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import and_, select
from sqlalchemy.orm import Session, object_session
from sqlalchemy.sql.elements import ColumnElement

from app.core.database.organization_scope import bound_organization_column, session_organization
from app.systems.access.users.eligibility import is_active_account, is_active_membership
from app.systems.access.users.models import Membership, PlatformOperator, User

_CACHE_KEY = "openslate.memberships"


def organization_required() -> HTTPException:
    return HTTPException(403, detail={"code": "organization_required",
                                      "message": "An active organization membership is required"})


def transaction_organization(db: Session) -> UUID | None:
    """The organization the transaction is bound to, by any binding path.

    Requests and workers record their organization in Python; any other binding
    (an operator command, a test) is read from the transaction setting itself.
    """

    org_id = session_organization(db)
    if org_id is None and isinstance(getattr(db, "info", None), dict):
        org_id = db.scalar(select(bound_organization_column()))
    return org_id


def bound_organization(db: Session) -> UUID:
    """The organization this transaction is bound to; refuse when there is none."""

    org_id = transaction_organization(db)
    if org_id is None:
        raise organization_required()
    return org_id


def bound_membership_join() -> ColumnElement[bool]:
    """Join a person to their membership in the bound organization only.

    ``memberships`` has no row-level security, so every join through it names the
    organization; without one, people of other organizations would match.
    """

    return and_(Membership.user_id == User.id, Membership.org_id == bound_organization_column())


def _cache(db: Session) -> dict[tuple[UUID, UUID], Membership]:
    info = getattr(db, "info", None)
    if not isinstance(info, dict):
        return {}
    cache: dict[tuple[UUID, UUID], Membership] = info.setdefault(_CACHE_KEY, {})
    return cache


def remember_membership(db: Session, membership: Membership) -> None:
    """Reuse a membership the request already loaded and checked."""

    _cache(db)[(membership.org_id, membership.user_id)] = membership


def organization_membership(
    db: Session, user_id: UUID, *, fresh: bool = False
) -> Membership | None:
    """The person's membership row in the bound organization, whatever its status.

    A read refreshes the row; ``fresh`` also skips the membership the request cached.
    """

    org_id = transaction_organization(db)
    if org_id is None:
        return None
    cache = _cache(db)
    cached = cache.get((org_id, user_id))
    if cached is not None and not fresh and object_session(cached) is db:
        return cached
    rows = db.scalars(select(Membership).where(
        Membership.org_id == org_id, Membership.user_id == user_id,
        Membership.is_deleted.is_(False),
    ).execution_options(populate_existing=True).limit(1)).all()
    membership = rows[0] if rows else None
    if membership is not None:
        cache[(org_id, user_id)] = membership
    else:
        cache.pop((org_id, user_id), None)
    return membership


def current_membership(
    db: Session, user: User, *, now: datetime | None = None
) -> Membership | None:
    """The person's membership in the bound organization when it can act now."""

    if not is_active_account(db, user, now=now):
        return None
    membership = organization_membership(db, user.id)
    if membership is None or not is_active_membership(user, membership, now=now):
        return None
    return membership


def require_current_membership(
    db: Session, user: User, *, now: datetime | None = None
) -> Membership:
    membership = current_membership(db, user, now=now)
    if membership is None:
        raise HTTPException(status_code=403, detail="Forbidden")
    return membership


def eligible_memberships(db: Session, user_id: UUID) -> list[Membership]:
    """Accepted, live organization grants; never choose between multiple grants."""
    from app.core.base_model import utc_now
    from app.systems.access.users.eligibility import established_user_clause
    from app.systems.manage.workspace.models import WorkspaceProfile

    return list(db.scalars(select(Membership).join(
        WorkspaceProfile, WorkspaceProfile.id == Membership.org_id
    ).where(
        Membership.user_id == user_id, Membership.status == "active",
        Membership.is_deleted.is_(False), WorkspaceProfile.is_deleted.is_(False),
        established_user_clause(),
        (Membership.expires_at.is_(None) | (Membership.expires_at > utc_now())),
    ).order_by(Membership.org_id)).all())


def is_platform_operator(db: Session, user_id: UUID) -> bool:
    """Whether the person owns the installation (installation-wide settings, backups)."""

    return db.scalar(
        select(PlatformOperator.id).where(PlatformOperator.user_id == user_id).limit(1)
    ) is not None
