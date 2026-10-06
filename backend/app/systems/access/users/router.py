"""User listing, retrieval, and invitation-backed creation endpoints."""

from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user, require_admin
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database import get_db
from app.systems.access.policy.scope import explain_access
from app.systems.access.users.coordination import (
    InvitationConflict,
    InvitationError,
    ProfileValidationError,
    not_found,
)
from app.systems.access.users.coordination import (
    get_user as load_user,
)
from app.systems.access.users.models import User, UserRole
from app.systems.access.users.schemas import (
    InvitationCreate,
    InvitationResponse,
    UserAccessResponse,
    UserCreate,
    UserPreferencesResponse,
    UserPreferencesUpdate,
    UserResponse,
)
from app.systems.access.users.service import (
    invite_user,
)

router = APIRouter(prefix="/users", tags=["users"])
AdminUser = Annotated[User, Depends(require_admin)]
CurrentUser = Annotated[User, Depends(get_current_user)]


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
    user = load_user(db, user_id)
    if user.is_deleted:
        raise not_found("User")
    return user


@router.get("/{user_id}/preferences", response_model=UserPreferencesResponse)
def get_user_preferences(
    user_id: UUID, actor: CurrentUser, response: Response
) -> UserPreferencesResponse:
    if user_id != actor.id:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "preferences_owner_mismatch",
                "message": "Preferences belong to the authenticated user",
            },
        )
    response.headers["Cache-Control"] = "no-store"
    return UserPreferencesResponse.model_validate(
        {"user_id": actor.id, "theme": actor.theme_preference, "appearance": actor.appearance}
    )


@router.patch("/{user_id}/preferences", response_model=UserPreferencesResponse)
def update_user_preferences(
    user_id: UUID,
    payload: UserPreferencesUpdate,
    actor: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> UserPreferencesResponse:
    if user_id != actor.id:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "preferences_owner_mismatch",
                "message": "Preferences belong to the authenticated user",
            },
        )
    try:
        # Authentication may have read an older preference. Serialize this
        # independent write before deciding whether a same-value update is harmless.
        db.refresh(actor, with_for_update=True)
        changed = False
        if "theme" in payload.model_fields_set and actor.theme_preference != payload.theme:
            actor.theme_preference = payload.theme
            changed = True
        if "appearance" in payload.model_fields_set:
            appearance = {**actor.appearance, **payload.appearance.model_dump(exclude_unset=True)}
            if appearance != actor.appearance:
                actor.appearance = appearance
                changed = True
        if changed:
            db.commit()
            db.refresh(actor)
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(status_code=503, detail="Unable to update preferences") from error
    response.headers["Cache-Control"] = "no-store"
    return UserPreferencesResponse.model_validate(
        {"user_id": actor.id, "theme": actor.theme_preference, "appearance": actor.appearance}
    )


@router.get("/{user_id}/access", response_model=UserAccessResponse)
def get_user_access(
    user_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> UserAccessResponse:
    """Show where the person has access and which groups give it."""

    user = load_user(db, user_id)
    if user.is_deleted:
        raise not_found("User")
    access, entries = explain_access(db, user)
    return UserAccessResponse.model_validate(
        {
            "user_id": user.id,
            "role": user.role,
            "unrestricted": access.unrestricted,
            "entries": [
                {
                    "department_id": entry.department_id,
                    "module_id": entry.module_id,
                    "level": entry.level,
                    "groups": [
                        {"group_id": group_id, "name": name, "level": level}
                        for group_id, name, level in entry.groups
                    ],
                }
                for entry in entries
            ],
        }
    )


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
