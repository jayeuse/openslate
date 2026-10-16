"""Keep overridden request actors inside their organization's row-level security scope.

The real current-user and current-identity dependencies resolve the membership and
bind the request transaction to its organization. A test that overrides them skips
that step, so wrap the override with ``scoped_override`` to bind the actor's
organization the same way.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import UUID

from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import scope_session
from app.core.database.session import get_db
from app.systems.access.users.models import Membership


def actor_organization(db: Session, user_id: UUID) -> UUID | None:
    """The organization of the actor's only active membership, else of its only membership."""

    rows = db.execute(
        select(Membership.org_id, Membership.status).where(
            Membership.user_id == user_id, Membership.is_deleted.is_(False)
        ).limit(3)
    ).all()
    active = [org_id for org_id, status in rows if status == "active"]
    if len(active) == 1:
        return active[0]
    return rows[0].org_id if len(rows) == 1 else None


def scoped_override(
    original: Callable[..., Any], *, org_id: UUID | None = None
) -> Callable[..., Any]:
    """Wrap a current-user or current-identity override so the request is scoped."""

    # Defaults, not Annotated: string annotations cannot resolve the closure's ``original``.
    def dependency(db: Session = Depends(get_db), value: Any = Depends(original)) -> Any:  # noqa: B008
        user_id = getattr(getattr(value, "user", value), "id", None)
        if isinstance(db, Session) and isinstance(user_id, UUID):
            scope_session(db, org_id or actor_organization(db, user_id))
        return value

    return dependency
