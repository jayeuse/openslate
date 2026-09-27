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
from app.systems.access.policy.checks import module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.fields.schemas import FieldResponse

router = APIRouter(prefix="/fields", tags=["fields"])
# A field is listed only for a user who can read its module.
FieldReadUser = Annotated[User, Depends(get_current_user)]


class FieldSortField(StrEnum):
    NAME = "name"
    POSITION = "position"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class FieldListResponse(StandardListResponse[FieldResponse]):
    pass


class FieldListRequest(StandardListRequest[FieldSortField]):
    module_id: UUID | None = None
    type: FieldType | None = None
    required: bool | None = None


FIELD_LIST_SPEC = ListQuerySpec(
    sort_fields={
        FieldSortField.NAME: cast(ColumnElement[Any], Field.name),
        FieldSortField.POSITION: cast(ColumnElement[Any], Field.position),
        FieldSortField.CREATED_AT: cast(ColumnElement[Any], Field.created_at),
        FieldSortField.UPDATED_AT: cast(ColumnElement[Any], Field.updated_at),
    },
    default_sort=FieldSortField.POSITION,
    tie_breaker=cast(ColumnElement[Any], Field.id),
    search_fields=(cast(ColumnElement[str], Field.name),),
    deleted_field=cast(ColumnElement[bool], Field.is_deleted),
)


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Field not found")


def _field(db: Session, user: User, field_id: UUID) -> Field:
    field = db.scalar(
        select(Field).where(
            Field.id == field_id, module_filter(db, user, AccessLevel.READ, Field.module_id)
        )
    )
    if field is None:
        raise _not_found()
    return field


@router.get("", response_model=FieldListResponse)
def list_fields(
    user: FieldReadUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[FieldListRequest, Query()],
) -> FieldListResponse:
    statement = select(Field).where(module_filter(db, user, AccessLevel.READ, Field.module_id))
    module_id = getattr(params, "module_id", None)
    field_type = getattr(params, "type", None)
    required = getattr(params, "required", None)
    if module_id is not None:
        statement = statement.where(Field.module_id == module_id)
    if field_type is not None:
        statement = statement.where(Field.type == field_type)
    if required is not None:
        statement = statement.where(Field.required == required)
    result = execute_standard_list(db, statement, params, FIELD_LIST_SPEC)
    return FieldListResponse.model_validate(
        {"items": result.items, "pagination": result.pagination},
        from_attributes=True,
    )


@router.get("/{field_id}", response_model=FieldResponse)
def get_field(
    field_id: UUID,
    user: FieldReadUser,
    db: Annotated[Session, Depends(get_db)],
) -> Field:
    return _field(db, user, field_id)
