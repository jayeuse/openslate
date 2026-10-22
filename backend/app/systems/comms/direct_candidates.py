"""Bounded name-only person discovery; this is not an organization directory."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from pydantic import Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.core.database.session import get_db
from app.systems.access.policy.readers import active_account_clause
from app.systems.access.users.membership import bound_membership_join
from app.systems.access.users.models import Membership, User
from app.systems.comms.access import error, fresh_membership
from app.systems.comms.direct_admission import admitted_direct_ids
from app.systems.comms.messages.schemas import WireModel


class DirectCandidateQuery(WireModel):
    q: str = Field(min_length=1, max_length=100)
    limit: int = Field(20, ge=1, le=20)

    @field_validator("q", mode="before")
    @classmethod
    def search_text(cls, value: object) -> object:
        if isinstance(value, str):
            value = value.strip()
            if "\x00" in value:
                raise ValueError("Search text cannot contain NUL")
            try:
                value.encode("utf-8")
            except UnicodeError as exc:
                raise ValueError("Search text must be valid Unicode") from exc
        return value


class DirectCandidate(WireModel):
    user_id: UUID
    display_name: str
    avatar_url: str | None


class DirectCandidates(WireModel):
    items: list[DirectCandidate]


router = APIRouter(
    prefix="/comms/direct-candidates",
    tags=["comms"],
    dependencies=[Depends(get_current_membership)],
)


@router.get("", response_model=DirectCandidates)
def list_candidates(
    query: Annotated[DirectCandidateQuery, Query()],
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(get_account_user)],
    response: Response,
) -> DirectCandidates:
    try:
        membership = fresh_membership(db, actor)
        if membership is None or membership.role == "guest":
            raise error("comms_post_denied", "Conversation access denied", 403)
        name = func.coalesce(func.nullif(User.display_name, ""), User.username)
        pattern = "%" + query.q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        candidates = db.execute(
            select(
                User.id,
                name.label("display_name"),
                User.avatar_file_id,
            )
            .join(Membership, bound_membership_join())
            .where(
                active_account_clause(),
                name.ilike(pattern, escape="\\"),
            )
            .order_by(name, User.id)
            .limit(100)
        ).all()
        admitted = admitted_direct_ids(db, actor, [row.id for row in candidates])
        items = [
            DirectCandidate(
                user_id=row.id,
                display_name=row.display_name,
                avatar_url=f"/api/users/{row.id}/avatar" if row.avatar_file_id else None,
            )
            for row in candidates
            if row.id in admitted
        ][: query.limit]
    except SQLAlchemyError as exc:
        db.rollback()
        raise error("comms_unavailable", "People lookup is unavailable", 503) from exc
    response.headers["Cache-Control"] = "no-store"
    return DirectCandidates(items=items)
