"""The authors of the posts a reader sees, for the author filter."""

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database import get_db
from app.systems.access.identity.eligibility import identity_eligible_clause
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.models import User, UserStatus
from app.systems.boards.post_listing import display_join
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.post_service import manager, published_expiry
from app.systems.boards.router import _board_with_access


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


class PostAuthorChoice(BaseModel):
    id: UUID
    label: str


class PostAuthorSortField(StrEnum):
    LABEL = "label"
    USERNAME = "username"


class PostAuthorListRequest(StandardListRequest[PostAuthorSortField]):
    pass


class PostAuthorListResponse(StandardListResponse[PostAuthorChoice]):
    pass


_AUTHOR_LABEL = func.coalesce(func.nullif(User.display_name, ""), User.username)
POST_AUTHOR_LIST_SPEC = ListQuerySpec(
    sort_fields={
        PostAuthorSortField.LABEL: cast(ColumnElement[Any], _AUTHOR_LABEL),
        PostAuthorSortField.USERNAME: cast(ColumnElement[Any], User.username),
    },
    default_sort=PostAuthorSortField.LABEL,
    tie_breaker=cast(ColumnElement[Any], User.id),
    search_fields=(
        cast(ColumnElement[str], _AUTHOR_LABEL),
        cast(ColumnElement[str], User.username),
    ),
)


@router.get("/{board_id}/post-authors", response_model=PostAuthorListResponse)
def list_post_authors(
    board_id: UUID,
    actor: Reader,
    db: Database,
    params: Annotated[PostAuthorListRequest, Query()],
) -> PostAuthorListResponse:
    """Active, unexpired authors of the published posts the reader can see."""

    board = _board_with_access(db, actor, board_id, AccessLevel.READ)
    visible_author_ids = (
        select(BoardPostRevision.author_id)
        .join(BoardPost, display_join())
        .where(
            BoardPost.board_id == board.id,
            BoardPost.is_deleted.is_(False),
            BoardPost.deleted_at.is_(None),
            BoardPost.status != "archived",
            published_expiry(actor, manager(db, board, actor), datetime.now(UTC)),
        )
        .distinct()
        .subquery()
    )
    result = execute_standard_list(
        db,
        select(User)
        .join(visible_author_ids, visible_author_ids.c.author_id == User.id)
        .where(
            User.status == UserStatus.ACTIVE.value,
            User.deleted_at.is_(None),
            identity_eligible_clause(),
            established_user_clause(),
        ),
        params,
        POST_AUTHOR_LIST_SPEC,
    )
    return PostAuthorListResponse(
        items=[
            PostAuthorChoice(id=author.id, label=author.display_name or author.username)
            for author in result.items
        ],
        pagination=result.pagination,
    )
