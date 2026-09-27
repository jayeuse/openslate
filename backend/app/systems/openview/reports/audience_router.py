"""Private, least-privilege target choices for Report audience editing."""

from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, load_only
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_non_guest
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database import get_db
from app.systems.access.identity.eligibility import identity_eligible_clause
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.models import User, UserStatus

router = APIRouter(tags=["reports"])
Writer = Annotated[User, Depends(require_non_guest)]
Database = Annotated[Session, Depends(get_db)]


class UserChoice(BaseModel):
    id: UUID
    username: str


class UserSort(StrEnum):
    USERNAME = "username"


class UserChoiceRequest(StandardListRequest[UserSort]):
    id: UUID | None = None


USER_LIST_SPEC = ListQuerySpec(
    sort_fields={UserSort.USERNAME: cast(ColumnElement[Any], User.username)},
    default_sort=UserSort.USERNAME,
    tie_breaker=cast(ColumnElement[Any], User.id),
    search_fields=(cast(ColumnElement[str], User.username),),
    deleted_field=None,
)


@router.get("/audience-users", response_model=StandardListResponse[UserChoice])
def list_report_audience_users(
    _editor: Writer,
    db: Database,
    params: Annotated[UserChoiceRequest, Query()],
) -> StandardListResponse[UserChoice]:
    """Active accounts. Saving the audience checks that the user can read the module."""

    statement = (
        select(User)
        .options(load_only(User.id, User.username))
        .where(
            User.status == UserStatus.ACTIVE.value,
            User.is_deleted.is_(False),
            User.deleted_at.is_(None),
            established_user_clause(),
            identity_eligible_clause(),
        )
    )
    if params.id is not None:
        statement = statement.where(User.id == params.id)
    result = execute_standard_list(db, statement, params, USER_LIST_SPEC)
    return StandardListResponse(
        items=[UserChoice(id=user.id, username=user.username) for user in result.items],
        pagination=result.pagination,
    )
