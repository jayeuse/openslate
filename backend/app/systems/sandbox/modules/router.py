from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel
from sqlalchemy import select
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
from app.systems.access.policy.checks import module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.scope import module_reader_ids
from app.systems.access.users.models import User
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.modules.schemas import ModuleResponse

router = APIRouter(prefix="/modules", tags=["modules"])
# A module is listed only for a user who can read it.
ModuleReadUser = Annotated[User, Depends(get_current_user)]


class ModuleSortField(StrEnum):
    NAME = "module_name"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class ModuleListResponse(StandardListResponse[ModuleResponse]):
    pass


class ModuleListRequest(StandardListRequest[ModuleSortField]):
    department_id: UUID | None = None


class AssignableUserSort(StrEnum):
    USERNAME = "username"
    DISPLAY_NAME = "display_name"


class AssignableUserResponse(BaseModel):
    id: UUID
    display_name: str | None
    username: str


ASSIGNABLE_USER_LIST_SPEC = ListQuerySpec(
    sort_fields={
        AssignableUserSort.USERNAME: cast(ColumnElement[Any], User.username),
        AssignableUserSort.DISPLAY_NAME: cast(ColumnElement[Any], User.display_name),
    },
    default_sort=AssignableUserSort.USERNAME,
    tie_breaker=cast(ColumnElement[Any], User.id),
    search_fields=(
        cast(ColumnElement[str], User.username),
        cast(ColumnElement[str], User.display_name),
    ),
    deleted_field=cast(ColumnElement[bool], User.is_deleted),
)


MODULE_LIST_SPEC = ListQuerySpec(
    sort_fields={
        ModuleSortField.NAME: cast(ColumnElement[Any], Module.module_name),
        ModuleSortField.CREATED_AT: cast(ColumnElement[Any], Module.created_at),
        ModuleSortField.UPDATED_AT: cast(ColumnElement[Any], Module.updated_at),
    },
    default_sort=ModuleSortField.NAME,
    tie_breaker=cast(ColumnElement[Any], Module.id),
    search_fields=(cast(ColumnElement[str], Module.module_name),),
    deleted_field=cast(ColumnElement[bool], Module.is_deleted),
)


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Module not found")


def _module(db: Session, user: User, module_id: UUID) -> Module:
    module = db.scalar(
        select(Module).where(
            Module.id == module_id, module_filter(db, user, AccessLevel.READ, Module.id)
        )
    )
    if module is None:
        raise _not_found()
    return module


@router.get("", response_model=ModuleListResponse)
def list_modules(
    user: ModuleReadUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[ModuleListRequest, Query()],
) -> ModuleListResponse:
    statement = select(Module).where(module_filter(db, user, AccessLevel.READ, Module.id))
    department_id = getattr(params, "department_id", None)
    if department_id is not None:
        statement = statement.where(Module.department_id == department_id)
    result = execute_standard_list(db, statement, params, MODULE_LIST_SPEC)
    return ModuleListResponse.model_validate(
        {"items": result.items, "pagination": result.pagination},
        from_attributes=True,
    )


@router.get("/{module_id}", response_model=ModuleResponse)
def get_module(
    module_id: UUID,
    user: ModuleReadUser,
    db: Annotated[Session, Depends(get_db)],
) -> Module:
    return _module(db, user, module_id)


@router.get(
    "/{module_id}/assignable-users",
    response_model=StandardListResponse[AssignableUserResponse],
)
def list_assignable_users(
    module_id: UUID,
    user: ModuleReadUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[StandardListRequest[AssignableUserSort], Query()],
    response: Response,
) -> StandardListResponse[AssignableUserResponse]:
    module = _module(db, user, module_id)
    if module.is_deleted or module.deleted_at is not None:
        raise _not_found()
    reader_ids = module_reader_ids(db, module_id)
    statement = select(User).where(User.id.in_(reader_ids))
    result = execute_standard_list(db, statement, params, ASSIGNABLE_USER_LIST_SPEC)
    response.headers["Cache-Control"] = "private, no-store"
    return StandardListResponse(
        items=[
            AssignableUserResponse(
                id=item.id,
                display_name=item.display_name,
                username=item.username,
            )
            for item in result.items
        ],
        pagination=result.pagination,
    )
