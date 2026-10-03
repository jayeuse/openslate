"""Authenticated search across the actor's readable content."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.common.listing import PaginationMetadata
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.platform.search.query import search_content
from app.systems.platform.search.schemas import SearchRequest, SearchResponse

router = APIRouter(prefix="/search", tags=["search"])
Actor = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


@router.get("", response_model=SearchResponse)
def search(
    params: Annotated[SearchRequest, Query()], actor: Actor, db: Database, response: Response
) -> SearchResponse:
    response.headers["Cache-Control"] = "private, no-store"
    if params.search is not None:
        return search_content(db, actor, params)
    return SearchResponse(
        items=[],
        pagination=PaginationMetadata(
            limit=params.limit, offset=params.offset, count=0, total=0, has_more=False
        ),
    )
