from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
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
from app.systems.access.policy.checks import module_filter, module_level, require_module_access
from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.scope import includes
from app.systems.access.users.models import User
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.fields.validation import parse_field_key, validate_record_data
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.record_triggers.outbox import enqueue_record_event
from app.systems.sandbox.records.display import FieldDisplayResolver, displayed_record
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.mutation_validation import (
    RecordValidationError,
    validate_live_user_assignments,
    validate_record_mutation,
)
from app.systems.sandbox.records.schemas import RecordCreate, RecordResponse, RecordUpdate
from app.systems.sandbox.relationships.errors import RelationshipError
from app.systems.sandbox.relationships.locking import lock_row

router = APIRouter(prefix="/records", tags=["records"])
# Every route checks the record's module: read to see it, write to change it.
RecordReadUser = Annotated[User, Depends(get_current_user)]
RecordWriteUser = Annotated[User, Depends(get_current_user)]


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


def _record_validation_http_error(error: RecordValidationError) -> HTTPException:
    detail = {
        "code": "record_validation_failed",
        "message": "Record data is invalid",
        "errors": [
            {
                "code": issue.code,
                "field_id": str(issue.field_id) if issue.field_id is not None else None,
                "message": issue.message,
            }
            for issue in error.issues
        ],
        "truncated": error.truncated,
    }
    code = (
        status.HTTP_409_CONFLICT
        if error.has_closed_field_mutation
        else status.HTTP_422_UNPROCESSABLE_CONTENT
    )
    return HTTPException(status_code=code, detail=detail)


def _require_patch(payload: RecordUpdate) -> None:
    if not payload.model_fields_set or any(
        getattr(payload, field) is None for field in payload.model_fields_set
    ):
        raise _invalid("At least one non-null field is required")


def _record(
    db: Session, user: User, record_id: UUID, level: AccessLevel = AccessLevel.READ
) -> Record:
    """A record in a module the user cannot read is reported as missing."""

    record = db.get(Record, record_id)
    granted = None if record is None else module_level(db, user, record.module_id)
    if record is None or granted is None:
        raise _not_found()
    if not includes(granted, level):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    return record


def _active_module(db: Session, module_id: UUID) -> Module:
    module = db.scalar(select(Module).where(Module.id == module_id, Module.is_deleted.is_(False)))
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


def _module_fields(db: Session, module_id: UUID) -> list[Field]:
    return list(db.scalars(select(Field).where(Field.module_id == module_id)).all())


def _active_fields(db: Session, module_id: UUID) -> list[Field]:
    return [field for field in _module_fields(db, module_id) if not field.is_deleted]


def _apply_creation_defaults(data: dict[str, Any], fields: list[Field]) -> dict[str, Any]:
    """Apply published field defaults only at real record creation time."""

    with_defaults = dict(data)
    for field in fields:
        key = str(field.id)
        if (
            key in with_defaults
            or field.is_deleted
            or FieldType(field.type) is FieldType.RELATIONSHIP
        ):
            continue
        if "defaultValue" in field.config:
            with_defaults[key] = field.config["defaultValue"]
    return with_defaults


def _validate_data(
    db: Session,
    module_id: UUID,
    data: dict[str, Any],
    fields: list[Field] | None = None,
) -> None:
    try:
        for key in data:
            parse_field_key(key)
        selected_fields = fields if fields is not None else _active_fields(db, module_id)
        validate_record_data(data, selected_fields)
    except ValueError as error:
        raise _invalid(str(error)) from error
    try:
        validate_live_user_assignments(db, module_id, data, selected_fields)
    except RecordValidationError as error:
        raise _record_validation_http_error(error) from error


def _merge_patch_data(
    db: Session,
    module_id: UUID,
    existing: dict[str, Any],
    requested: dict[str, Any],
) -> dict[str, Any]:
    fields = _module_fields(db, module_id)
    normalized = validate_record_mutation(requested, existing, fields)
    validate_live_user_assignments(db, module_id, normalized, fields)
    return normalized


def _commit(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict(message) from error


@router.get("", response_model=RecordListResponse)
def list_records(
    user: RecordReadUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[RecordListRequest, Query()],
) -> RecordListResponse:
    statement = select(Record).where(module_filter(db, user, AccessLevel.READ, Record.module_id))
    module_id = getattr(params, "module_id", None)
    if module_id is not None:
        statement = statement.where(Record.module_id == module_id)
    result = execute_standard_list(db, statement, params, RECORD_LIST_SPEC)
    resolvers: dict[UUID, FieldDisplayResolver] = {}
    items: list[RecordResponse] = []
    for record in result.items:
        if record.module_id not in resolvers:
            resolvers[record.module_id] = FieldDisplayResolver(
                db, record.module_id, _module_fields(db, record.module_id)
            )
        items.append(displayed_record(record, resolvers[record.module_id]))
    return RecordListResponse.model_validate(
        {"items": items, "pagination": result.pagination},
        from_attributes=True,
    )


@router.get("/{record_id}", response_model=RecordResponse)
def get_record(
    record_id: UUID,
    user: RecordReadUser,
    db: Annotated[Session, Depends(get_db)],
) -> RecordResponse:
    record = _record(db, user, record_id)
    return displayed_record(
        record, FieldDisplayResolver(db, record.module_id, _module_fields(db, record.module_id))
    )


@router.post("", response_model=RecordResponse, status_code=status.HTTP_201_CREATED)
def create_record(
    payload: RecordCreate,
    user: RecordWriteUser,
    db: Annotated[Session, Depends(get_db)],
) -> RecordResponse:
    require_module_access(db, user, payload.module_id, AccessLevel.WRITE)
    _active_module(db, payload.module_id)
    _lock_active_module(db, payload.module_id)
    fields = _module_fields(db, payload.module_id)
    if not any(not field.is_deleted for field in fields):
        raise _conflict("Module has no active fields")
    try:
        normalized_data = validate_record_mutation(
            _apply_creation_defaults(payload.data, fields),
            {},
            fields,
        )
        validate_live_user_assignments(db, payload.module_id, normalized_data, fields)
    except RecordValidationError as error:
        raise _record_validation_http_error(error) from error
    record = Record(module_id=payload.module_id, data=normalized_data)
    db.add(record)
    db.flush()
    enqueue_record_event(db, record, previous=None)
    _commit(db, "Unable to create record")
    db.refresh(record)
    return displayed_record(record, FieldDisplayResolver(db, record.module_id, fields))


@router.patch("/{record_id}", response_model=RecordResponse)
def update_record(
    record_id: UUID,
    payload: RecordUpdate,
    user: RecordWriteUser,
    db: Annotated[Session, Depends(get_db)],
) -> RecordResponse:
    _require_patch(payload)
    record = _record(db, user, record_id, AccessLevel.WRITE)
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
        previous = dict(record.data)
        try:
            record.data = _merge_patch_data(db, record.module_id, record.data, payload.data)
        except RecordValidationError as error:
            raise _record_validation_http_error(error) from error
        enqueue_record_event(db, record, previous=previous)
    _commit(db, "Unable to update record")
    return displayed_record(
        record, FieldDisplayResolver(db, record.module_id, _module_fields(db, record.module_id))
    )


@router.delete("/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_record(
    record_id: UUID,
    user: RecordWriteUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    record = _record(db, user, record_id, AccessLevel.WRITE)
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
    user: RecordWriteUser,
    db: Annotated[Session, Depends(get_db)],
) -> RecordResponse:
    record = _record(db, user, record_id, AccessLevel.WRITE)
    if not record.is_deleted:
        raise _conflict("Record is not deleted")
    _active_module(db, record.module_id)
    _lock_active_module(db, record.module_id)
    record = _lock_record(db, record)
    if not record.is_deleted:
        raise _conflict("Record is not deleted")
    # A record keeps values for primitive fields that were closed after it was
    # created.  Restore validates those values against the complete module
    # field set; create and update continue to validate against active fields.
    _validate_data(db, record.module_id, record.data, _module_fields(db, record.module_id))
    record.is_deleted = False
    record.deleted_at = None
    _commit(db, "Unable to restore record")
    return displayed_record(
        record, FieldDisplayResolver(db, record.module_id, _module_fields(db, record.module_id))
    )
