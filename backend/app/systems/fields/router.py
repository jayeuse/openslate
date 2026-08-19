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
from app.systems.fields.models import Field, FieldType
from app.systems.fields.schemas import (
    FieldCreate,
    FieldReorder,
    FieldResponse,
    FieldUpdate,
)
from app.systems.fields.validation import field_config, validate_field_value
from app.systems.modules.models import Module
from app.systems.records.models import Record
from app.systems.users.models import User, UserRole

router = APIRouter(prefix="/fields", tags=["fields"])
module_fields_router = APIRouter(prefix="/modules", tags=["fields"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]


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


def _conflict(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


def _invalid(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=message)


def _require_patch(payload: FieldUpdate) -> None:
    if not payload.model_fields_set or any(
        getattr(payload, field) is None for field in payload.model_fields_set
    ):
        raise _invalid("At least one non-null field is required")


def _field(db: Session, field_id: UUID) -> Field:
    field = db.get(Field, field_id)
    if field is None:
        raise _not_found()
    return field


def _active_module(db: Session, module_id: UUID) -> Module:
    module = db.scalar(
        select(Module).where(Module.id == module_id, Module.is_deleted.is_(False))
    )
    if module is None:
        raise _conflict("Module is not active")
    return module


def _name_conflict(
    db: Session,
    module_id: UUID,
    name: str,
    exclude_id: UUID | None = None,
) -> bool:
    statement = select(Field.id).where(
        Field.module_id == module_id,
        Field.name == name,
        Field.is_deleted.is_(False),
    )
    if exclude_id is not None:
        statement = statement.where(Field.id != exclude_id)
    return db.scalar(statement) is not None


def _position_conflict(
    db: Session,
    module_id: UUID,
    position: int,
    exclude_id: UUID | None = None,
) -> bool:
    statement = select(Field.id).where(
        Field.module_id == module_id,
        Field.position == position,
        Field.is_deleted.is_(False),
    )
    if exclude_id is not None:
        statement = statement.where(Field.id != exclude_id)
    return db.scalar(statement) is not None


def _active_records(db: Session, module_id: UUID) -> list[Record]:
    return list(
        db.scalars(
            select(Record).where(
                Record.module_id == module_id,
                Record.is_deleted.is_(False),
            )
        ).all()
    )


def _validate_change_impact(
    db: Session,
    field: Field,
    field_type: FieldType,
    required: bool,
    config: dict[str, Any],
) -> None:
    try:
        field_config(field_type, config)
    except ValueError as error:
        raise _invalid(str(error)) from error

    if (
        field_type == FieldType(field.type)
        and required == field.required
        and config == field.config
    ):
        return

    candidate = Field(
        module_id=field.module_id,
        name=field.name,
        type=field_type,
        required=required,
        position=field.position,
        config=config,
    )
    candidate.id = field.id
    for record in _active_records(db, field.module_id):
        key = str(field.id)
        if required and (key not in record.data or record.data[key] is None):
            raise _conflict("Field change would invalidate active records")
        if key in record.data:
            try:
                validate_field_value(candidate, record.data[key])
            except ValueError as error:
                raise _conflict("Field change would invalidate active records") from error


def _commit(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict(message) from error


@router.get("", response_model=FieldListResponse)
def list_fields(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[FieldListRequest, Query()],
) -> FieldListResponse:
    statement = select(Field)
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
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Field:
    return _field(db, field_id)


@router.post("", response_model=FieldResponse, status_code=status.HTTP_201_CREATED)
def create_field(
    payload: FieldCreate,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Field:
    _active_module(db, payload.module_id)
    if _name_conflict(db, payload.module_id, payload.name):
        raise _conflict("Field name unavailable")
    if _position_conflict(db, payload.module_id, payload.position):
        raise _conflict("Field position unavailable")
    field = Field(
        module_id=payload.module_id,
        name=payload.name,
        type=payload.type,
        required=payload.required,
        position=payload.position,
        config=payload.config,
    )
    db.add(field)
    _commit(db, "Field name or position unavailable")
    db.refresh(field)
    return field


@router.patch("/{field_id}", response_model=FieldResponse)
def update_field(
    field_id: UUID,
    payload: FieldUpdate,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Field:
    _require_patch(payload)
    field = _field(db, field_id)
    if field.is_deleted:
        raise _conflict("Field is deleted")
    if payload.module_id is not None and payload.module_id != field.module_id:
        raise _conflict("Field module cannot be changed")
    _active_module(db, field.module_id)

    if payload.name is not None and _name_conflict(db, field.module_id, payload.name, field.id):
        raise _conflict("Field name unavailable")
    if (
        payload.position is not None
        and _position_conflict(db, field.module_id, payload.position, field.id)
    ):
        raise _conflict("Field position unavailable")

    field_type = payload.type or FieldType(field.type)
    required = field.required if payload.required is None else payload.required
    config = field.config if payload.config is None else payload.config
    _validate_change_impact(db, field, field_type, required, config)

    if payload.name is not None:
        field.name = payload.name
    if payload.type is not None:
        field.type = payload.type
    if payload.required is not None:
        field.required = payload.required
    if payload.position is not None:
        field.position = payload.position
    if payload.config is not None:
        field.config = payload.config
    _commit(db, "Field name or position unavailable")
    return field


@router.delete("/{field_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_field(
    field_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    field = _field(db, field_id)
    if field.is_deleted:
        raise _conflict("Field is already deleted")
    has_data = db.scalar(
        select(func.count())
        .select_from(Record)
        .where(
            Record.module_id == field.module_id,
            Record.is_deleted.is_(False),
            Record.data.has_key(str(field.id)),
        )
    )
    if has_data:
        raise _conflict("Field is present in active records")
    field.is_deleted = True
    field.deleted_at = datetime.now(UTC)
    _commit(db, "Unable to delete field")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{field_id}/restore", response_model=FieldResponse)
def restore_field(
    field_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Field:
    field = _field(db, field_id)
    if not field.is_deleted:
        raise _conflict("Field is not deleted")
    _active_module(db, field.module_id)
    if _name_conflict(db, field.module_id, field.name, field.id):
        raise _conflict("Field name unavailable")
    if _position_conflict(db, field.module_id, field.position, field.id):
        raise _conflict("Field position unavailable")
    _validate_change_impact(db, field, FieldType(field.type), field.required, field.config)
    field.is_deleted = False
    field.deleted_at = None
    _commit(db, "Field name or position unavailable")
    return field


@module_fields_router.post(
    "/{module_id}/fields/reorder",
    response_model=list[FieldResponse],
)
def reorder_module_fields(
    module_id: UUID,
    payload: FieldReorder,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> list[Field]:
    _active_module(db, module_id)
    fields = list(
        db.scalars(
            select(Field)
            .where(Field.module_id == module_id, Field.is_deleted.is_(False))
            .order_by(Field.position, Field.id)
        ).all()
    )
    if len(payload.field_ids) != len(fields) or set(payload.field_ids) != {
        field.id for field in fields
    }:
        raise _conflict("Reorder must include every active module field exactly once")

    fields_by_id = {field.id: field for field in fields}
    temporary_start = max(field.position for field in fields) + len(fields) + 1
    for position, field_id in enumerate(payload.field_ids):
        fields_by_id[field_id].position = temporary_start + position
    db.flush()
    for position, field_id in enumerate(payload.field_ids):
        fields_by_id[field_id].position = position
    _commit(db, "Field position unavailable")
    return [fields_by_id[field_id] for field_id in payload.field_ids]
