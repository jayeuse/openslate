from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
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
from app.systems.access.policy.checks import department_filter
from app.systems.access.users.models import User
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.departments.schemas import DepartmentResponse

router = APIRouter(prefix="/departments", tags=["departments"])
# A department is listed only for a user who can read something in it.
DepartmentReadUser = Annotated[User, Depends(get_current_user)]


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


def _department(db: Session, user: User, department_id: UUID) -> Department:
    department = db.scalar(
        select(Department).where(
            Department.id == department_id, department_filter(db, user, Department.id)
        )
    )
    if department is None:
        raise _not_found()
    return department


@router.get("", response_model=DepartmentListResponse)
def list_departments(
    user: DepartmentReadUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[StandardListRequest[DepartmentSortField], Query()],
) -> DepartmentListResponse:
    statement = select(Department).where(department_filter(db, user, Department.id))
    result = execute_standard_list(db, statement, params, DEPARTMENT_LIST_SPEC)
    return DepartmentListResponse.model_validate(
        {"items": result.items, "pagination": result.pagination},
        from_attributes=True,
    )


@router.get("/{department_id}", response_model=DepartmentResponse)
def get_department(
    department_id: UUID,
    user: DepartmentReadUser,
    db: Annotated[Session, Depends(get_db)],
) -> Department:
    return _department(db, user, department_id)
