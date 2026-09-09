"""Role transport endpoints."""

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_fresh_exact_admin, require_roles
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database import get_db
from app.systems.users.coordination import (
    BUILT_IN_ROLES,
    commit,
    conflict,
    forbidden,
    is_built_in,
    lock_active_role,
    lock_role_any_state,
    non_deleted_user_count,
)
from app.systems.users.coordination import get_role as load_role
from app.systems.users.models import Role, User, UserRole
from app.systems.users.schemas import RoleCreate, RoleResponse, RoleUpdate

router = APIRouter(prefix="/roles", tags=["roles"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]


class RoleSortField(StrEnum):
    ROLE = "role"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class RoleListResponse(StandardListResponse[RoleResponse]):
    pass


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


def _require_patch(payload: RoleUpdate) -> None:
    if not payload.model_fields_set or any(
        getattr(payload, field) is None for field in payload.model_fields_set
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="At least one non-null field is required",
        )


@router.get("", response_model=RoleListResponse)
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


@router.get("/{role_id}", response_model=RoleResponse)
def get_role(
    role_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Role:
    return load_role(db, role_id)


@router.post("", response_model=RoleResponse, status_code=status.HTTP_201_CREATED)
def create_role(
    payload: RoleCreate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Role:
    require_fresh_exact_admin(db, admin.id)
    if payload.role in BUILT_IN_ROLES:
        raise conflict("Built-in roles are protected")
    role = Role(role=payload.role, permissions=payload.permissions)
    db.add(role)
    commit(db, "Role name unavailable")
    db.refresh(role)
    return role


@router.patch("/{role_id}", response_model=RoleResponse)
def update_role(
    role_id: UUID,
    payload: RoleUpdate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Role:
    _require_patch(payload)
    require_fresh_exact_admin(db, admin.id)
    role = lock_active_role(db, role_id)
    if is_built_in(role) and payload.role is not None:
        raise forbidden("Built-in roles are protected")
    if payload.role in BUILT_IN_ROLES:
        raise conflict("Built-in roles are protected")
    if payload.role is not None:
        role.role = payload.role
    if payload.permissions is not None:
        role.permissions = payload.permissions
    commit(db, "Role name unavailable")
    db.refresh(role)
    return role


@router.delete("/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_role(
    role_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    require_fresh_exact_admin(db, admin.id)
    role = lock_active_role(db, role_id)
    if is_built_in(role):
        raise forbidden("Built-in roles are protected")
    if role.is_deleted:
        raise conflict("Role is already deleted")
    if non_deleted_user_count(db, role.id):
        raise conflict("Role has assigned users")
    role.is_deleted = True
    role.deleted_at = datetime.now(UTC)
    commit(db, "Unable to delete role")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{role_id}/restore", response_model=RoleResponse)
def restore_role(
    role_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Role:
    require_fresh_exact_admin(db, admin.id)
    role = lock_role_any_state(db, role_id)
    if is_built_in(role):
        raise forbidden("Built-in roles are protected")
    if not role.is_deleted:
        raise conflict("Role is not deleted")
    role.is_deleted = False
    role.deleted_at = None
    commit(db, "Unable to restore role")
    return role
