"""Content-free state that the author or a manager needs before acting on a post."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.post_models import BoardPostRevision
from app.systems.boards.post_service import manager, post
from app.systems.boards.router import _board_with_access


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


class PostManageState(BaseModel):
    id: UUID
    status: str
    board_revision: int
    post_revision: int
    published_before: bool
    """True when a delete archives the post instead of removing it."""


@router.get("/{board_id}/posts/{post_id}/manage-state", response_model=PostManageState)
def read_post_manage_state(
    board_id: UUID, post_id: UUID, actor: Reader, db: Database
) -> PostManageState:
    board = _board_with_access(db, actor, board_id, AccessLevel.WRITE)
    item = post(db, board.id, post_id)
    if item.author_id != actor.id and not manager(db, board, actor):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Manage access required")
    published_before = (
        db.scalar(
            select(BoardPostRevision.id).where(BoardPostRevision.post_id == item.id).limit(1)
        )
        is not None
    )
    return PostManageState(
        id=item.id,
        status=item.status,
        board_revision=board.revision,
        post_revision=item.revision,
        published_before=published_before,
    )
