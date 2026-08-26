from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
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
from app.systems.fields.models import Field
from app.systems.fields.validation import parse_field_key, validate_record_data
from app.systems.modules.models import Module
from app.systems.records.models import Record
from app.systems.records.schemas import RecordCreate, RecordResponse, RecordUpdate
from app.systems.relationships.service import RelationshipError, lock_row
from app.systems.users.models import User, UserRole

router = APIRouter(prefix="/records", tags=["records"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]


class RecordSortField(StrEnum):
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class RecordListResponse(StandardListResponse[RecordResponse]):
    pass


class RecordListRequest(StandardListRequest[RecordSortField]):
    module_id: UUID | None = None


RECORD_LIST_SPEC = ListQuerySpec(
    sort_fields={
        RecordSortField.CREATED_AT: cast(ColumnElement[Any], Record.created_at),
        RecordSortField.UPDATED_AT: cast(ColumnElement[Any], Record.updated_at),
    },
    default_sort=RecordSortField.CREATED_AT,
    tie_breaker=cast(ColumnElement[Any], Record.id),
    deleted_field=cast(ColumnElement[bool], Record.is_deleted),
)


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Record not found")


def _conflict(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


def _invalid(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=message)


def _require_patch(payload: RecordUpdate) -> None:
    if not payload.model_fields_set or any(
        getattr(payload, field) is None for field in payload.model_fields_set
    ):
        raise _invalid("At least one non-null field is required")


def _record(db: Session, record_id: UUID) -> Record:
    record = db.get(Record, record_id)
    if record is None:
        raise _not_found()
    return record


def _active_module(db: Session, module_id: UUID) -> Module:
    module = db.scalar(
        select(Module).where(Module.id == module_id, Module.is_deleted.is_(False))
    )
    if module is None:
        raise _conflict("Module is not active")
    return module


def _lock_module(db: Session, module_id: UUID) -> Module:
    try:
        module = lock_row(db, Module, module_id)
    except RelationshipError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error
    if module is None:
        raise _conflict("Module is not active")
    return module


def _lock_active_module(db: Session, module_id: UUID) -> Module:
    module = _lock_module(db, module_id)
    if module.is_deleted is True:
        raise _conflict("Module is not active")
    return module


def _lock_record(db: Session, record: Record) -> Record:
    try:
        locked = lock_row(db, Record, record.id)
    except RelationshipError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error
    if locked is None:
        raise _not_found()
    return locked


def _active_fields(db: Session, module_id: UUID) -> list[Field]:
    return list(
        db.scalars(
            select(Field).where(
                Field.module_id == module_id,
                Field.is_deleted.is_(False),
            )
        ).all()
    )


def _validate_data(db: Session, module_id: UUID, data: dict[str, Any]) -> None:
    try:
        for key in data:
            parse_field_key(key)
        validate_record_data(data, _active_fields(db, module_id))
    except ValueError as error:
        raise _invalid(str(error)) from error


def _commit(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict(message) from error


@router.get("", response_model=RecordListResponse)
def list_records(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[RecordListRequest, Query()],
) -> RecordListResponse:
    statement = select(Record)
    module_id = getattr(params, "module_id", None)
    if module_id is not None:
        statement = statement.where(Record.module_id == module_id)
    result = execute_standard_list(db, statement, params, RECORD_LIST_SPEC)
    return RecordListResponse.model_validate(
        {"items": result.items, "pagination": result.pagination},
        from_attributes=True,
    )


@router.get("/{record_id}", response_model=RecordResponse)
def get_record(
    record_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Record:
    return _record(db, record_id)


@router.post("", response_model=RecordResponse, status_code=status.HTTP_201_CREATED)
def create_record(
    payload: RecordCreate,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Record:
    _active_module(db, payload.module_id)
    _lock_active_module(db, payload.module_id)
    _validate_data(db, payload.module_id, payload.data)
    record = Record(module_id=payload.module_id, data=payload.data)
    db.add(record)
    _commit(db, "Unable to create record")
    db.refresh(record)
    return record


@router.patch("/{record_id}", response_model=RecordResponse)
def update_record(
    record_id: UUID,
    payload: RecordUpdate,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Record:
    _require_patch(payload)
    record = _record(db, record_id)
    if record.is_deleted:
        raise _conflict("Record is deleted")
    if payload.module_id is not None and payload.module_id != record.module_id:
        raise _conflict("Record module cannot be changed")
    _active_module(db, record.module_id)
    _lock_active_module(db, record.module_id)
    record = _lock_record(db, record)
    if record.is_deleted:
        raise _conflict("Record is deleted")
    if payload.data is not None:
        _validate_data(db, record.module_id, payload.data)
        record.data = payload.data
    _commit(db, "Unable to update record")
    return record


@router.delete("/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_record(
    record_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    record = _record(db, record_id)
    if record.is_deleted:
        raise _conflict("Record is already deleted")
    _active_module(db, record.module_id)
    _lock_active_module(db, record.module_id)
    record = _lock_record(db, record)
    if record.is_deleted:
        raise _conflict("Record is already deleted")
    record.is_deleted = True
    record.deleted_at = datetime.now(UTC)
    _commit(db, "Unable to delete record")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{record_id}/restore", response_model=RecordResponse)
def restore_record(
    record_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Record:
    record = _record(db, record_id)
    if not record.is_deleted:
        raise _conflict("Record is not deleted")
    _active_module(db, record.module_id)
    _lock_active_module(db, record.module_id)
    record = _lock_record(db, record)
    if not record.is_deleted:
        raise _conflict("Record is not deleted")
    _validate_data(db, record.module_id, record.data)
    record.is_deleted = False
    record.deleted_at = None
    _commit(db, "Unable to restore record")
    return record
