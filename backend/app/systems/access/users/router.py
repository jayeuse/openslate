"""User listing, retrieval, and invitation-backed creation endpoints."""

from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_admin
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database import get_db
from app.systems.access.users.coordination import (
    InvitationConflict,
    InvitationError,
    ProfileValidationError,
)
from app.systems.access.users.coordination import (
    get_user as load_user,
)
from app.systems.access.users.models import User, UserRole
from app.systems.access.users.schemas import (
    InvitationCreate,
    InvitationResponse,
    UserCreate,
    UserResponse,
)
from app.systems.access.users.service import (
    invite_user,
)

router = APIRouter(prefix="/users", tags=["users"])
AdminUser = Annotated[User, Depends(require_admin)]


class UserSortField(StrEnum):
    EMAIL = "email"
    USERNAME = "username"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class UserListResponse(StandardListResponse[UserResponse]):
    pass


class UserListRequest(StandardListRequest[UserSortField]):
    role: UserRole | None = None


USER_LIST_SPEC = ListQuerySpec(
    sort_fields={
        UserSortField.EMAIL: cast(ColumnElement[Any], User.email),
        UserSortField.USERNAME: cast(ColumnElement[Any], User.username),
        UserSortField.CREATED_AT: cast(ColumnElement[Any], User.created_at),
        UserSortField.UPDATED_AT: cast(ColumnElement[Any], User.updated_at),
    },
    default_sort=UserSortField.USERNAME,
    tie_breaker=cast(ColumnElement[Any], User.id),
    search_fields=(cast(ColumnElement[str], User.email), cast(ColumnElement[str], User.username)),
    deleted_field=cast(ColumnElement[bool], User.is_deleted),
)


@router.get("", response_model=UserListResponse)
def list_users(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[UserListRequest, Query()],
) -> UserListResponse:
    statement = select(User)
    if params.role is not None:
        statement = statement.where(User.role == params.role.value)
    result = execute_standard_list(db, statement, params, USER_LIST_SPEC)
    return UserListResponse.model_validate(
        {"items": result.items, "pagination": result.pagination}, from_attributes=True
    )


@router.get("/{user_id}", response_model=UserResponse)
def get_user(
    user_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    return load_user(db, user_id)


@router.post("", response_model=InvitationResponse, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> InvitationResponse:
    try:
        user = invite_user(
            db,
            InvitationCreate(**payload.model_dump()),
            actor_id=admin.id,
        )
    except InvitationConflict as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email or username is already in use",
        ) from error
    except ProfileValidationError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except InvitationError as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Unable to send invitation",
        ) from error
    return InvitationResponse(
        user=UserResponse.model_validate(user),
        delivery="email",
    )
