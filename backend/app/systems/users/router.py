from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_roles
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database import get_db
from app.core.security import hash_password
from app.systems.users.models import Role, User, UserRole
from app.systems.users.schemas import (
    RoleCreate,
    RoleResponse,
    RoleUpdate,
    UserCreate,
    UserResponse,
    UserUpdate,
)

router = APIRouter(prefix="/users", tags=["users"])
roles_router = APIRouter(prefix="/roles", tags=["roles"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]

BUILT_IN_ROLES = frozenset(role.value for role in UserRole)


class RoleSortField(StrEnum):
    ROLE = "role"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class UserSortField(StrEnum):
    USERNAME = "username"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class RoleListResponse(StandardListResponse[RoleResponse]):
    pass


class UserListResponse(StandardListResponse[UserResponse]):
    pass


class UserListRequest(StandardListRequest[UserSortField]):
    role_id: UUID | None = None


ROLE_LIST_SPEC = ListQuerySpec(
    sort_fields={
        RoleSortField.ROLE: cast(ColumnElement[Any], Role.role),
        RoleSortField.CREATED_AT: cast(ColumnElement[Any], Role.created_at),
        RoleSortField.UPDATED_AT: cast(ColumnElement[Any], Role.updated_at),
    },
    default_sort=RoleSortField.ROLE,
    tie_breaker=cast(ColumnElement[Any], Role.id),
    search_fields=(cast(ColumnElement[str], Role.role),),
    deleted_field=cast(ColumnElement[bool], Role.is_deleted),
)
USER_LIST_SPEC = ListQuerySpec(
    sort_fields={
        UserSortField.USERNAME: cast(ColumnElement[Any], User.username),
        UserSortField.CREATED_AT: cast(ColumnElement[Any], User.created_at),
        UserSortField.UPDATED_AT: cast(ColumnElement[Any], User.updated_at),
    },
    default_sort=UserSortField.USERNAME,
    tie_breaker=cast(ColumnElement[Any], User.id),
    search_fields=(cast(ColumnElement[str], User.username),),
    deleted_field=cast(ColumnElement[bool], User.is_deleted),
)


def _not_found(resource: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{resource} not found")


def _conflict(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


def _forbidden(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=message)


def _require_patch(fields: set[str], payload: object) -> None:
    if not fields or any(getattr(payload, field) is None for field in fields):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="At least one non-null field is required",
        )


def _active_role(db: Session, role_id: UUID) -> Role:
    role = db.scalar(select(Role).where(Role.id == role_id, Role.is_deleted.is_(False)))
    if role is None:
        raise _conflict("Role is not active")
    return role


def _role(db: Session, role_id: UUID) -> Role:
    role = db.get(Role, role_id)
    if role is None:
        raise _not_found("Role")
    return role


def _user(db: Session, user_id: UUID) -> User:
    user = db.scalar(
        select(User).options(joinedload(User.role)).where(User.id == user_id)
    )
    if user is None:
        raise _not_found("User")
    return user


def _is_built_in(role: Role) -> bool:
    return role.role in BUILT_IN_ROLES


def _active_user_count(db: Session, role_id: UUID) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(User)
            .where(User.role_id == role_id, User.is_deleted.is_(False))
        )
        or 0
    )


def _active_admin_count(db: Session) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(User)
            .join(Role, User.role_id == Role.id)
            .where(
                User.is_deleted.is_(False),
                Role.is_deleted.is_(False),
                Role.role == UserRole.ADMIN,
            )
        )
        or 0
    )


def _commit(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict(message) from error


@roles_router.get("", response_model=RoleListResponse)
def list_roles(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[StandardListRequest[RoleSortField], Query()],
) -> RoleListResponse:
    result = execute_standard_list(db, select(Role), params, ROLE_LIST_SPEC)
    return RoleListResponse.model_validate(
        {"items": result.items, "pagination": result.pagination},
        from_attributes=True,
    )


@roles_router.get("/{role_id}", response_model=RoleResponse)
def get_role(
    role_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Role:
    return _role(db, role_id)


@roles_router.post("", response_model=RoleResponse, status_code=status.HTTP_201_CREATED)
def create_role(
    payload: RoleCreate,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Role:
    if payload.role in BUILT_IN_ROLES:
        raise _conflict("Built-in roles are protected")
    role = Role(role=payload.role, permissions=payload.permissions)
    db.add(role)
    _commit(db, "Role name unavailable")
    db.refresh(role)
    return role


@roles_router.patch("/{role_id}", response_model=RoleResponse)
def update_role(
    role_id: UUID,
    payload: RoleUpdate,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Role:
    _require_patch(payload.model_fields_set, payload)
    role = _role(db, role_id)
    if _is_built_in(role) and payload.role is not None:
        raise _forbidden("Built-in roles are protected")
    if payload.role in BUILT_IN_ROLES:
        raise _conflict("Built-in roles are protected")
    if payload.role is not None:
        role.role = payload.role
    if payload.permissions is not None:
        role.permissions = payload.permissions
    _commit(db, "Role name unavailable")
    db.refresh(role)
    return role


@roles_router.delete("/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_role(
    role_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    role = _role(db, role_id)
    if _is_built_in(role):
        raise _forbidden("Built-in roles are protected")
    if role.is_deleted:
        raise _conflict("Role is already deleted")
    if _active_user_count(db, role.id):
        raise _conflict("Role has active users")
    role.is_deleted = True
    role.deleted_at = datetime.now(UTC)
    _commit(db, "Unable to delete role")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@roles_router.post("/{role_id}/restore", response_model=RoleResponse)
def restore_role(
    role_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Role:
    role = _role(db, role_id)
    if _is_built_in(role):
        raise _forbidden("Built-in roles are protected")
    if not role.is_deleted:
        raise _conflict("Role is not deleted")
    role.is_deleted = False
    role.deleted_at = None
    _commit(db, "Unable to restore role")
    return role


@router.get("", response_model=UserListResponse)
def list_users(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[UserListRequest, Query()],
) -> UserListResponse:
    statement = select(User)
    role_id = getattr(params, "role_id", None)
    if role_id is not None:
        statement = statement.where(User.role_id == role_id)
    result = execute_standard_list(
        db,
        statement,
        params,
        USER_LIST_SPEC,
    )
    return UserListResponse.model_validate(
        {"items": result.items, "pagination": result.pagination},
        from_attributes=True,
    )


@router.get("/{user_id}", response_model=UserResponse)
def get_user(
    user_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    return _user(db, user_id)


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    role = _active_role(db, payload.role_id)
    user = User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        role_id=role.id,
        role=role,
    )
    db.add(user)
    _commit(db, "Username unavailable")
    return _user(db, user.id)


@router.patch("/{user_id}", response_model=UserResponse)
def update_user(
    user_id: UUID,
    payload: UserUpdate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    _require_patch(payload.model_fields_set, payload)
    user = _user(db, user_id)
    if user.is_deleted:
        raise _conflict("User is deleted")
    if payload.role_id is not None and payload.role_id != user.role_id:
        role = _active_role(db, payload.role_id)
        if user.role and user.role.role == UserRole.ADMIN and role.role != UserRole.ADMIN:
            if _active_admin_count(db) <= 1:
                raise _conflict("Cannot remove the last active admin")
        user.role_id = role.id
        user.role = role
    if payload.username is not None:
        user.username = payload.username
    if payload.password is not None:
        user.password_hash = hash_password(payload.password)
    _commit(db, "Username unavailable")
    return _user(db, user.id)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    user = _user(db, user_id)
    if user.is_deleted:
        raise _conflict("User is already deleted")
    if user.id == admin.id:
        raise _forbidden("You cannot delete your own account")
    if user.role and user.role.role == UserRole.ADMIN and _active_admin_count(db) <= 1:
        raise _conflict("Cannot delete the last active admin")
    user.is_deleted = True
    user.deleted_at = datetime.now(UTC)
    _commit(db, "Unable to delete user")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{user_id}/restore", response_model=UserResponse)
def restore_user(
    user_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    user = _user(db, user_id)
    if not user.is_deleted:
        raise _conflict("User is not deleted")
    _active_role(db, user.role_id)
    user.is_deleted = False
    user.deleted_at = None
    _commit(db, "Unable to restore user")
    return _user(db, user.id)
