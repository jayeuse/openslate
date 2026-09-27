"""Content-free Board announcement management metadata (not yet mounted)."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.common.dependencies import require_non_guest
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.boards.announcement_service import (
    announcement,
    displayed_revision,
    not_found,
    revision_visible,
)
from app.systems.boards.models import BoardPermission
from app.systems.boards.router import _board_with_access


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Manager = Annotated[
    User,
    Depends(require_non_guest),
]
Database = Annotated[Session, Depends(get_db)]


class AnnouncementManageState(BaseModel):
    id: UUID
    status: str
    board_revision: int
    announcement_revision: int


@router.get(
    "/{board_id}/announcements/{announcement_id}/manage-state",
    response_model=AnnouncementManageState,
)
def read_announcement_manage_state(
    board_id: UUID, announcement_id: UUID, actor: Manager, db: Database
) -> AnnouncementManageState:
    board = _board_with_access(db, actor, board_id, BoardPermission.MANAGE)
    item = announcement(db, board.id, announcement_id, actor)
    displayed = displayed_revision(db, item)
    if displayed is not None and not revision_visible(db, displayed, actor):
        raise not_found()
    return AnnouncementManageState(
        id=item.id,
        status=item.status,
        board_revision=board.revision,
        announcement_revision=item.revision,
    )
