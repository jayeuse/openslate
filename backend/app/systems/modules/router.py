from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_roles
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database import get_db
from app.systems.departments.models import Department
from app.systems.fields.models import Field
from app.systems.fields.validation import validate_module_schema
from app.systems.lifecycle.exceptions import LifecycleError
from app.systems.lifecycle.schemas import LifecycleTargetType
from app.systems.lifecycle.service import reopen_lifecycle
from app.systems.modules.models import Module
from app.systems.modules.schemas import ModuleCreate, ModuleResponse, ModuleUpdate
from app.systems.records.models import Record
from app.systems.relationships.service import RelationshipError, lock_row
from app.systems.users.models import User, UserRole

router = APIRouter(prefix="/modules", tags=["modules"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]


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


def _conflict(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


def _require_patch(payload: ModuleUpdate) -> None:
    if not payload.model_fields_set or any(
        getattr(payload, field) is None for field in payload.model_fields_set
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="At least one non-null field is required",
        )


def _module(db: Session, module_id: UUID) -> Module:
    module = db.get(Module, module_id)
    if module is None:
        raise _not_found()
    return module


def _active_department(db: Session, department_id: UUID) -> Department:
    department = db.scalar(
        select(Department).where(
            Department.id == department_id,
            Department.is_deleted.is_(False),
        )
    )
    if department is None:
        raise _conflict("Department is not active")
    return department


def _lock_module(db: Session, module: Module) -> Module:
    try:
        locked = lock_row(db, Module, module.id)
    except RelationshipError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error
    if locked is None:
        raise _conflict("Module is unavailable")
    return locked


def _lock_department(db: Session, department_id: UUID) -> Department:
    try:
        department = lock_row(db, Department, department_id)
    except RelationshipError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error
    if department is None:
        raise _conflict("Department is unavailable")
    return department


def _name_conflict(
    db: Session,
    department_id: UUID,
    name: str,
    exclude_id: UUID | None = None,
) -> bool:
    statement = select(Module.id).where(
        Module.department_id == department_id,
        Module.module_name == name,
        Module.is_deleted.is_(False),
    )
    if exclude_id is not None:
        statement = statement.where(Module.id != exclude_id)
    return db.scalar(statement) is not None


def _active_dependency_count(
    db: Session,
    model: type[Field] | type[Record],
    module_id: UUID,
) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(model)
            .where(model.module_id == module_id, model.is_deleted.is_(False))
        )
        or 0
    )


def _active_fields(db: Session, module_id: UUID) -> list[Field]:
    return list(
        db.scalars(
            select(Field)
            .where(Field.module_id == module_id, Field.is_deleted.is_(False))
            .order_by(Field.position, Field.id)
        ).all()
    )


def _commit(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict(message) from error


@router.get("", response_model=ModuleListResponse)
def list_modules(
    _: AdminUser,
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
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Module:
    return _module(db, module_id)


@router.post("/{module_id}/schema/accept", response_model=ModuleResponse)
def accept_module_schema(
    module_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Module:
    module = _module(db, module_id)
    if module.is_deleted:
        raise _conflict("Module is deleted")
    module = _lock_module(db, module)
    if module.is_deleted:
        raise _conflict("Module is deleted")
    try:
        validate_module_schema(_active_fields(db, module.id))
    except ValueError as error:
        raise _conflict(f"Module schema is invalid: {error}") from error
    if module.is_schema_accepted:
        return module
    module.is_schema_accepted = True
    _commit(db, "Unable to accept module schema")
    return module


@router.post("", response_model=ModuleResponse, status_code=status.HTTP_201_CREATED)
def create_module(
    payload: ModuleCreate,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Module:
    _active_department(db, payload.department_id)
    if _lock_department(db, payload.department_id).is_deleted is True:
        raise _conflict("Department is not active")
    if _name_conflict(db, payload.department_id, payload.module_name):
        raise _conflict("Module name unavailable")
    module = Module(
        department_id=payload.department_id,
        module_name=payload.module_name,
    )
    db.add(module)
    _commit(db, "Module name unavailable")
    db.refresh(module)
    return module


@router.patch("/{module_id}", response_model=ModuleResponse)
def update_module(
    module_id: UUID,
    payload: ModuleUpdate,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Module:
    _require_patch(payload)
    module = _module(db, module_id)
    if module.is_deleted:
        raise _conflict("Module is deleted")
    if payload.department_id is not None and payload.department_id != module.department_id:
        raise _conflict("Module department cannot be changed")
    _active_department(db, module.department_id)
    _lock_department(db, module.department_id)
    module = _lock_module(db, module)
    if module.is_deleted:
        raise _conflict("Module is deleted")
    if payload.module_name is not None:
        if _name_conflict(db, module.department_id, payload.module_name, module.id):
            raise _conflict("Module name unavailable")
        module.module_name = payload.module_name
    _commit(db, "Module name unavailable")
    return module


def delete_module(
    module_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    module = _module(db, module_id)
    if module.is_deleted:
        raise _conflict("Module is already deleted")
    _active_department(db, module.department_id)
    _lock_department(db, module.department_id)
    module = _lock_module(db, module)
    if module.is_deleted:
        raise _conflict("Module is already deleted")
    if _active_dependency_count(db, Field, module.id):
        raise _conflict("Module has active fields")
    if _active_dependency_count(db, Record, module.id):
        raise _conflict("Module has active records")
    module.is_deleted = True
    module.deleted_at = datetime.now(UTC)
    _commit(db, "Unable to delete module")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/{module_id}", status_code=status.HTTP_204_NO_CONTENT)
def legacy_delete_module(
    module_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    _module(db, module_id)
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"code": "close_required", "message": "Use Close to close this module"},
    )


@router.post("/{module_id}/restore", response_model=ModuleResponse)
def restore_module(
    module_id: UUID,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Module:
    module = _module(db, module_id)
    if not module.is_deleted:
        raise _conflict("Module is not deleted")
    try:
        reopen_lifecycle(db, LifecycleTargetType.MODULE, module_id, user.id)
    except LifecycleError as error:
        raise HTTPException(status_code=int(error.status_code), detail=error.detail) from error
    return _module(db, module_id)
