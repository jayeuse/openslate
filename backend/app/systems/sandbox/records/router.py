from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
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
from app.systems.sandbox.automations.outbox import enqueue_record_event
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.fields.validation import (
    parse_field_key,
    validate_field_value,
    validate_record_data,
)
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.schemas import RecordCreate, RecordResponse, RecordUpdate
from app.systems.sandbox.relationships.errors import RelationshipError
from app.systems.sandbox.relationships.locking import lock_row

router = APIRouter(prefix="/records", tags=["records"])
RecordReadUser = Annotated[User, Depends(require_capability(Capability.RECORDS_READ))]
RecordWriteUser = Annotated[User, Depends(require_capability(Capability.RECORDS_WRITE))]


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


@dataclass(frozen=True)
class RecordValidationIssue:
    code: str
    field_id: UUID | None
    message: str
    closed_field_mutation: bool = False


class RecordValidationError(ValueError):
    def __init__(
        self,
        issues: list[RecordValidationIssue],
        truncated: bool,
        has_closed_field_mutation: bool = False,
    ) -> None:
        super().__init__("Record data is invalid")
        self.issues = tuple(issues)
        self.truncated = truncated
        self._has_closed_field_mutation = has_closed_field_mutation

    @property
    def has_closed_field_mutation(self) -> bool:
        return self._has_closed_field_mutation or any(
            issue.closed_field_mutation for issue in self.issues
        )


def validate_record_mutation(
    new_data: dict[str, Any],
    current_data: dict[str, Any],
    fields: list[Field],
) -> dict[str, Any]:
    """Validate a create or active-value replacement and return normalized data."""

    fields_by_id = {str(field.id): field for field in fields}
    closed_keys = {str(field.id) for field in fields if field.is_deleted}
    issues: list[RecordValidationIssue] = []
    truncated = False
    has_closed_field_mutation = False

    def add_issue(
        code: str,
        field_id: UUID | None,
        message: str,
        *,
        closed_field_mutation: bool = False,
    ) -> None:
        nonlocal truncated, has_closed_field_mutation
        if closed_field_mutation:
            has_closed_field_mutation = True
        if len(issues) < 20:
            issues.append(
                RecordValidationIssue(
                    code=code,
                    field_id=field_id,
                    message=message,
                    closed_field_mutation=closed_field_mutation,
                )
            )
        else:
            truncated = True

    normalized_active: dict[str, Any] = {}
    submitted_active_keys: set[str] = set()
    submitted_items = sorted(new_data.items(), key=lambda item: str(item[0]))

    # Phase 1: closed values are retained verbatim; only changed or new values
    # are conflicts. Relationship values are never accepted, but a changed
    # closed relationship is represented by one closed mutation issue.
    for key, raw_value in submitted_items:
        if not isinstance(key, str):
            continue

        field = fields_by_id.get(key)
        if field is None or not field.is_deleted:
            continue

        field_type = FieldType(field.type)
        if field_type is FieldType.RELATIONSHIP:
            closed_value_changed = (
                key not in current_data
                or type(current_data[key]) is not type(raw_value)
                or current_data[key] != raw_value
            )
            if closed_value_changed:
                add_issue(
                    "closed_field_mutation",
                    field.id,
                    "Closed field values cannot be changed",
                    closed_field_mutation=True,
                )
            else:
                add_issue(
                    "relationship_field",
                    field.id,
                    "Relationship fields are managed separately",
                )
            continue
        if (
            key not in current_data
            or type(current_data[key]) is not type(raw_value)
            or current_data[key] != raw_value
        ):
            add_issue(
                "closed_field_mutation",
                field.id,
                "Closed field values cannot be changed",
                closed_field_mutation=True,
            )

    # Phase 2: known active values are validated and normalized. Relationship
    # values are rejected before the type registry is consulted.
    for key, raw_value in submitted_items:
        if not isinstance(key, str):
            continue
        field = fields_by_id.get(key)
        if field is None or field.is_deleted:
            continue

        submitted_active_keys.add(key)
        field_type = FieldType(field.type)
        if field_type is FieldType.RELATIONSHIP:
            add_issue(
                "relationship_field",
                field.id,
                "Relationship fields are managed separately",
            )
            continue

        try:
            normalized_active[key] = validate_field_value(field, raw_value)
        except ValueError as error:
            code = (
                "required_field"
                if field.required and (raw_value is None or raw_value == "")
                else "invalid_field_value"
            )
            message = "Field is required" if code == "required_field" else str(error)
            add_issue(code, field.id, message)

    # Phase 3: malformed and unknown keys are reported after known values.
    for key, _raw_value in submitted_items:
        if not isinstance(key, str):
            add_issue("invalid_field_key", None, "Field key is invalid")
            continue
        if key in fields_by_id:
            continue
        try:
            parsed_key = parse_field_key(key)
        except ValueError:
            add_issue("invalid_field_key", None, "Field key is invalid")
        else:
            add_issue("unknown_field", parsed_key, "Unknown or inactive field")

    # Phase 4: active required fields must be submitted for every replacement.
    for field in sorted(fields, key=lambda candidate: (candidate.position, str(candidate.id))):
        field_type = FieldType(field.type)
        key = str(field.id)
        if not field.is_deleted and field_type is not FieldType.RELATIONSHIP:
            if field.required and key not in submitted_active_keys:
                add_issue("required_field", field.id, "Field is required")

    if issues or has_closed_field_mutation:
        raise RecordValidationError(issues, truncated, has_closed_field_mutation)

    merged = {key: value for key, value in current_data.items() if key in closed_keys}
    merged.update(normalized_active)
    return merged


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


def _record(db: Session, record_id: UUID) -> Record:
    record = db.get(Record, record_id)
    if record is None:
        raise _not_found()
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
        validate_record_data(data, fields if fields is not None else _active_fields(db, module_id))
    except ValueError as error:
        raise _invalid(str(error)) from error


def _merge_patch_data(
    db: Session,
    module_id: UUID,
    existing: dict[str, Any],
    requested: dict[str, Any],
) -> dict[str, Any]:
    fields = _module_fields(db, module_id)
    return validate_record_mutation(requested, existing, fields)


def _commit(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict(message) from error


@router.get("", response_model=RecordListResponse)
def list_records(
    _: RecordReadUser,
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
    _: RecordReadUser,
    db: Annotated[Session, Depends(get_db)],
) -> Record:
    return _record(db, record_id)


@router.post("", response_model=RecordResponse, status_code=status.HTTP_201_CREATED)
def create_record(
    payload: RecordCreate,
    _: RecordWriteUser,
    db: Annotated[Session, Depends(get_db)],
) -> Record:
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
    except RecordValidationError as error:
        raise _record_validation_http_error(error) from error
    record = Record(module_id=payload.module_id, data=normalized_data)
    db.add(record)
    db.flush()
    enqueue_record_event(db, record, previous=None)
    _commit(db, "Unable to create record")
    db.refresh(record)
    return record


@router.patch("/{record_id}", response_model=RecordResponse)
def update_record(
    record_id: UUID,
    payload: RecordUpdate,
    _: RecordWriteUser,
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
        previous = dict(record.data)
        try:
            record.data = _merge_patch_data(db, record.module_id, record.data, payload.data)
        except RecordValidationError as error:
            raise _record_validation_http_error(error) from error
        enqueue_record_event(db, record, previous=previous)
    _commit(db, "Unable to update record")
    return record


@router.delete("/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_record(
    record_id: UUID,
    _: RecordWriteUser,
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
    _: RecordWriteUser,
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
    # A record keeps values for primitive fields that were closed after it was
    # created.  Restore validates those values against the complete module
    # field set; create and update continue to validate against active fields.
    _validate_data(db, record.module_id, record.data, _module_fields(db, record.module_id))
    record.is_deleted = False
    record.deleted_at = None
    _commit(db, "Unable to restore record")
    return record
