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
from app.systems.departments.schemas import (
    DepartmentCreate,
    DepartmentResponse,
    DepartmentUpdate,
)
from app.systems.modules.models import Module
from app.systems.relationships.service import RelationshipError, lock_row
from app.systems.users.models import User, UserRole

router = APIRouter(prefix="/departments", tags=["departments"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]


class DepartmentSortField(StrEnum):
    NAME = "department_name"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class DepartmentListResponse(StandardListResponse[DepartmentResponse]):
    pass


DEPARTMENT_LIST_SPEC = ListQuerySpec(
    sort_fields={
        DepartmentSortField.NAME: cast(ColumnElement[Any], Department.department_name),
        DepartmentSortField.CREATED_AT: cast(ColumnElement[Any], Department.created_at),
        DepartmentSortField.UPDATED_AT: cast(ColumnElement[Any], Department.updated_at),
    },
    default_sort=DepartmentSortField.NAME,
    tie_breaker=cast(ColumnElement[Any], Department.id),
    search_fields=(cast(ColumnElement[str], Department.department_name),),
    deleted_field=cast(ColumnElement[bool], Department.is_deleted),
)


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Department not found")


def _conflict(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


def _require_patch(payload: DepartmentUpdate) -> None:
    if not payload.model_fields_set or any(
        getattr(payload, field) is None for field in payload.model_fields_set
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="At least one non-null field is required",
        )


def _department(db: Session, department_id: UUID) -> Department:
    department = db.get(Department, department_id)
    if department is None:
        raise _not_found()
    return department


def _lock_department(db: Session, department: Department) -> Department:
    try:
        locked = lock_row(db, Department, department.id)
    except RelationshipError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error
    if locked is None:
        raise _conflict("Department is unavailable")
    return locked


def _name_conflict(db: Session, name: str, exclude_id: UUID | None = None) -> bool:
    statement = select(Department.id).where(
        Department.department_name == name,
        Department.is_deleted.is_(False),
    )
    if exclude_id is not None:
        statement = statement.where(Department.id != exclude_id)
    return db.scalar(statement) is not None


def _active_module_count(db: Session, department_id: UUID) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(Module)
            .where(Module.department_id == department_id, Module.is_deleted.is_(False))
        )
        or 0
    )


def _commit(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict(message) from error


@router.get("", response_model=DepartmentListResponse)
def list_departments(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[StandardListRequest[DepartmentSortField], Query()],
) -> DepartmentListResponse:
    result = execute_standard_list(db, select(Department), params, DEPARTMENT_LIST_SPEC)
    return DepartmentListResponse.model_validate(
        {"items": result.items, "pagination": result.pagination},
        from_attributes=True,
    )


@router.get("/{department_id}", response_model=DepartmentResponse)
def get_department(
    department_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Department:
    return _department(db, department_id)


@router.post("", response_model=DepartmentResponse, status_code=status.HTTP_201_CREATED)
def create_department(
    payload: DepartmentCreate,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Department:
    if _name_conflict(db, payload.department_name):
        raise _conflict("Department name unavailable")
    department = Department(department_name=payload.department_name)
    db.add(department)
    _commit(db, "Department name unavailable")
    db.refresh(department)
    return department


@router.patch("/{department_id}", response_model=DepartmentResponse)
def update_department(
    department_id: UUID,
    payload: DepartmentUpdate,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Department:
    _require_patch(payload)
    department = _department(db, department_id)
    if department.is_deleted:
        raise _conflict("Department is deleted")
    if payload.department_name is not None:
        if _name_conflict(db, payload.department_name, department.id):
            raise _conflict("Department name unavailable")
        department.department_name = payload.department_name
    _commit(db, "Department name unavailable")
    return department


@router.delete("/{department_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_department(
    department_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    department = _department(db, department_id)
    if department.is_deleted:
        raise _conflict("Department is already deleted")
    department = _lock_department(db, department)
    if _active_module_count(db, department.id):
        raise _conflict("Department has active modules")
    department.is_deleted = True
    department.deleted_at = datetime.now(UTC)
    _commit(db, "Unable to delete department")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{department_id}/restore", response_model=DepartmentResponse)
def restore_department(
    department_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Department:
    department = _department(db, department_id)
    if not department.is_deleted:
        raise _conflict("Department is not deleted")
    department = _lock_department(db, department)
    if _name_conflict(db, department.department_name, department.id):
        raise _conflict("Department name unavailable")
    department.is_deleted = False
    department.deleted_at = None
    _commit(db, "Department name unavailable")
    return department
