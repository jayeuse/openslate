"""Visible published announcement author choices (not yet mounted)."""

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.models import User, UserStatus
from app.systems.boards.announcement_listing import display_join
from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.announcement_router import MAX_ANNOUNCEMENTS
from app.systems.boards.announcement_service import audience_clause, published_expiry, read_manager
from app.systems.boards.models import BoardPermission
from app.systems.boards.router import _board_with_access


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


class AnnouncementAuthorChoice(BaseModel):
    id: UUID
    label: str


@router.get("/{board_id}/announcement-authors", response_model=list[AnnouncementAuthorChoice])
def list_announcement_authors(
    board_id: UUID, actor: Reader, db: Database
) -> list[AnnouncementAuthorChoice]:
    board = _board_with_access(db, actor, board_id, BoardPermission.VIEW)
    manager = read_manager(db, board, actor)
    visible_author_ids = (
        select(BoardAnnouncementRevision.author_id)
        .join(BoardAnnouncement, display_join())
        .where(
            BoardAnnouncement.board_id == board.id,
            BoardAnnouncement.is_deleted.is_(False),
            BoardAnnouncement.deleted_at.is_(None),
            BoardAnnouncement.status != "archived",
            audience_clause(BoardAnnouncementRevision, actor),
            published_expiry(actor, manager, datetime.now(UTC)),
        )
        .distinct()
        .subquery()
    )
    rows = db.execute(
        select(User.id, User.username)
        .join(visible_author_ids, visible_author_ids.c.author_id == User.id)
        .where(
            User.status == UserStatus.ACTIVE.value,
            User.is_deleted.is_(False),
            User.deleted_at.is_(None),
            established_user_clause(),
        )
        .order_by(User.username, User.id)
        .limit(MAX_ANNOUNCEMENTS)
    ).all()
    return [AnnouncementAuthorChoice(id=author_id, label=username) for author_id, username in rows]
