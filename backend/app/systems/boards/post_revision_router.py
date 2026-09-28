"""The edit history of a post: every published version, newest first."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.models import Board
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.post_router import _published_post
from app.systems.boards.post_schemas import (
    PostRevisionListResponse,
    PostRevisionResponse,
    PostRevisionSummary,
)
from app.systems.boards.post_service import manager, not_found, post
from app.systems.boards.router import _board_with_access


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


def _history_post(db: Session, board: Board, post_id: UUID, actor: User) -> BoardPost:
    """Readers open the history of a post on the Board; its author and managers always can."""

    item = post(db, board.id, post_id)
    if item.author_id == actor.id or manager(db, board, actor):
        return item
    if _published_post(db, board, post_id, actor) is None:
        raise not_found()
    return item


def _summary(revision: BoardPostRevision) -> PostRevisionSummary:
    return PostRevisionSummary(
        id=revision.id,
        post_id=revision.post_id,
        publication_number=revision.publication_number,
        author_id=revision.author_id,
        title=revision.title,
        published_at=revision.published_at,
    )


@router.get("/{board_id}/posts/{post_id}/revisions", response_model=PostRevisionListResponse)
def list_post_revisions(
    board_id: UUID, post_id: UUID, actor: Reader, db: Database
) -> PostRevisionListResponse:
    board = _board_with_access(db, actor, board_id, AccessLevel.READ)
    item = _history_post(db, board, post_id, actor)
    revisions = db.scalars(
        select(BoardPostRevision)
        .where(BoardPostRevision.post_id == item.id, BoardPostRevision.is_deleted.is_(False))
        .order_by(BoardPostRevision.publication_number.desc())
    ).all()
    return PostRevisionListResponse(
        post_id=item.id, items=[_summary(revision) for revision in revisions]
    )


@router.get(
    "/{board_id}/posts/{post_id}/revisions/{revision_id}", response_model=PostRevisionResponse
)
def read_post_revision(
    board_id: UUID, post_id: UUID, revision_id: UUID, actor: Reader, db: Database
) -> PostRevisionResponse:
    board = _board_with_access(db, actor, board_id, AccessLevel.READ)
    item = _history_post(db, board, post_id, actor)
    revision = db.scalar(
        select(BoardPostRevision).where(
            BoardPostRevision.id == revision_id,
            BoardPostRevision.post_id == item.id,
            BoardPostRevision.is_deleted.is_(False),
        )
    )
    if revision is None:
        raise not_found()
    return PostRevisionResponse(
        **_summary(revision).model_dump(),
        body=revision.body,
        links=revision.links,
        expires_at=revision.expires_at,
    )
