from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_capability
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.access.users.permissions import Capability
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.modules.schemas import ModuleResponse

router = APIRouter(prefix="/modules", tags=["modules"])
ModuleReadUser = Annotated[User, Depends(require_capability(Capability.MODULES_READ))]


class ModuleSortField(StrEnum):
    NAME = "module_name"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class ModuleListResponse(StandardListResponse[ModuleResponse]):
    pass


class ModuleListRequest(StandardListRequest[ModuleSortField]):
    department_id: UUID | None = None


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


def _module(db: Session, module_id: UUID) -> Module:
    module = db.get(Module, module_id)
    if module is None:
        raise _not_found()
    return module


@router.get("", response_model=ModuleListResponse)
def list_modules(
    _: ModuleReadUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[ModuleListRequest, Query()],
) -> ModuleListResponse:
    statement = select(Module)
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
    _: ModuleReadUser,
    db: Annotated[Session, Depends(get_db)],
) -> Module:
    return _module(db, module_id)
