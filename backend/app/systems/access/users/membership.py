"""The bounded S04 bridge until organization-aware authorization replaces it."""

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.users.models import Membership


# TEMPORARY: removed in S07
def sole_active_membership(db: Session, user_id: UUID) -> Membership:
    """Refuse authority unless exactly one active membership can be established."""
    pending = any(isinstance(row, Membership) and row.user_id == user_id for row in db.dirty)
    memberships = db.scalars(
        select(Membership).where(
            Membership.user_id == user_id,
            Membership.status == "active",
            Membership.is_deleted.is_(False),
        ).execution_options(populate_existing=not pending, autoflush=False).limit(2)
    ).all()
    if len(memberships) == 1:
        return memberships[0]
    raise HTTPException(status_code=403, detail="Forbidden")
