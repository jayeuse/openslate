from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
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
from app.systems.fields.models import Field, FieldType
from app.systems.fields.schemas import (
    FieldCreate,
    FieldReorder,
    FieldResponse,
    FieldUpdate,
)
from app.systems.fields.validation import field_config, validate_field_value
from app.systems.lifecycle.exceptions import LifecycleError
from app.systems.lifecycle.schemas import LifecycleTargetType
from app.systems.lifecycle.service import reopen_lifecycle
from app.systems.modules.models import Module
from app.systems.records.models import Record
from app.systems.relationships.service import (
    RelationshipError,
    lock_modules,
    lock_row,
    validate_cardinality_change,
    validate_relationship_modules,
)
from app.systems.users.models import User
from app.systems.users.permissions import Capability

router = APIRouter(prefix="/fields", tags=["fields"])
module_fields_router = APIRouter(prefix="/modules", tags=["fields"])
FieldReadUser = Annotated[User, Depends(require_capability(Capability.FIELDS_READ))]
FieldWriteUser = Annotated[User, Depends(require_capability(Capability.FIELDS_WRITE))]


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


def _invalidate_module_schema(module: Module) -> None:
    module.is_schema_accepted = False


def _lock_field(db: Session, field: Field) -> Field:
    try:
        locked = lock_row(db, Field, field.id)
    except RelationshipError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error
    if locked is None:
        raise _not_found()
    return locked


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
) -> dict[str, Any]:
    try:
        normalized_config = field_config(field_type, config)
    except ValueError as error:
        raise _invalid(str(error)) from error

    if (
        field_type == FieldType(field.type)
        and required == field.required
        and normalized_config == field.config
    ):
        return normalized_config

    candidate = Field(
        module_id=field.module_id,
        name=field.name,
        type=field_type,
        required=required,
        position=field.position,
        config=normalized_config,
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
    return normalized_config


def _commit(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict(message) from error


@router.get("", response_model=FieldListResponse)
def list_fields(
    _: FieldReadUser,
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
    _: FieldReadUser,
    db: Annotated[Session, Depends(get_db)],
) -> Field:
    return _field(db, field_id)


@router.post("", response_model=FieldResponse, status_code=status.HTTP_201_CREATED)
def create_field(
    payload: FieldCreate,
    _: FieldWriteUser,
    db: Annotated[Session, Depends(get_db)],
) -> Field:
    source_module = _active_module(db, payload.module_id)
    locked_source_module: Module
    if payload.type is FieldType.RELATIONSHIP:
        # FieldCreate guarantees these values are present for relationship fields.
        target_module_id = payload.relationship_target_module_id
        if target_module_id is None:
            raise _invalid("Relationship fields require a target module")
        try:
            locked_modules = lock_modules(db, [payload.module_id, target_module_id])
        except RelationshipError as error:
            raise HTTPException(status_code=error.status_code, detail=error.detail) from error
        target_module = locked_modules.get(target_module_id)
        if target_module is None:
            target_module = _active_module(db, target_module_id)
        locked_source_module = locked_modules.get(payload.module_id, source_module)
        try:
            validate_relationship_modules(locked_source_module, target_module)
        except RelationshipError as error:
            raise HTTPException(status_code=error.status_code, detail=error.detail) from error
    else:
        locked_source_module = _lock_active_module(db, payload.module_id)
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
        relationship_target_module_id=payload.relationship_target_module_id,
        relationship_multiple_targets=payload.relationship_multiple_targets,
        relationship_multiple_sources=payload.relationship_multiple_sources,
    )
    _invalidate_module_schema(locked_source_module)
    db.add(field)
    _commit(db, "Field name or position unavailable")
    db.refresh(field)
    return field


@router.patch("/{field_id}", response_model=FieldResponse)
def update_field(
    field_id: UUID,
    payload: FieldUpdate,
    _: FieldWriteUser,
    db: Annotated[Session, Depends(get_db)],
) -> Field:
    _require_patch(payload)
    field = _field(db, field_id)
    if field.is_deleted:
        raise _conflict("Field is deleted")
    if payload.module_id is not None and payload.module_id != field.module_id:
        raise _conflict("Field module cannot be changed")
    _active_module(db, field.module_id)
    module = _lock_active_module(db, field.module_id)
    field = _lock_field(db, field)
    if field.is_deleted:
        raise _conflict("Field is deleted")

    current_type = FieldType(field.type)
    if payload.type is not None and payload.type is not current_type:
        raise _conflict("Field type cannot be changed")
    relationship_metadata = (
        payload.relationship_target_module_id,
        payload.relationship_multiple_targets,
        payload.relationship_multiple_sources,
    )
    if current_type is FieldType.RELATIONSHIP:
        if (
            payload.relationship_target_module_id is not None
            and payload.relationship_target_module_id != field.relationship_target_module_id
        ):
            raise _conflict("Relationship target module cannot be changed")
        if payload.required is True:
            raise _conflict("Relationship fields cannot be required")
        if payload.config is not None and payload.config:
            raise _invalid("Relationship fields cannot have configuration")
        try:
            validate_cardinality_change(
                db,
                field,
                payload.relationship_multiple_targets,
                payload.relationship_multiple_sources,
            )
        except RelationshipError as error:
            raise HTTPException(status_code=error.status_code, detail=error.detail) from error
    elif any(value is not None for value in relationship_metadata):
        raise _conflict("Primitive fields cannot have relationship metadata")

    if payload.name is not None and _name_conflict(db, field.module_id, payload.name, field.id):
        raise _conflict("Field name unavailable")
    if payload.position is not None and _position_conflict(
        db, field.module_id, payload.position, field.id
    ):
        raise _conflict("Field position unavailable")

    field_type = current_type
    required = field.required if payload.required is None else payload.required
    config = field.config if payload.config is None else payload.config
    config = _validate_change_impact(db, field, field_type, required, config)

    effective = any(
        (
            payload.name is not None and payload.name != field.name,
            payload.required is not None and payload.required != field.required,
            payload.position is not None and payload.position != field.position,
            payload.config is not None and config != field.config,
            current_type is FieldType.RELATIONSHIP
            and payload.relationship_multiple_targets is not None
            and payload.relationship_multiple_targets != field.relationship_multiple_targets,
            current_type is FieldType.RELATIONSHIP
            and payload.relationship_multiple_sources is not None
            and payload.relationship_multiple_sources != field.relationship_multiple_sources,
        )
    )

    if payload.name is not None:
        field.name = payload.name
    if payload.required is not None:
        field.required = payload.required
    if payload.position is not None:
        field.position = payload.position
    if payload.config is not None:
        field.config = config
    if current_type is FieldType.RELATIONSHIP:
        if payload.relationship_multiple_targets is not None:
            field.relationship_multiple_targets = payload.relationship_multiple_targets
        if payload.relationship_multiple_sources is not None:
            field.relationship_multiple_sources = payload.relationship_multiple_sources
    if effective:
        _invalidate_module_schema(module)
    _commit(db, "Field name or position unavailable")
    return field


def delete_field(
    field_id: UUID,
    _: FieldWriteUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    field = _field(db, field_id)
    if field.is_deleted:
        raise _conflict("Field is already deleted")
    _active_module(db, field.module_id)
    module = _lock_active_module(db, field.module_id)
    field = _lock_field(db, field)
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
    _invalidate_module_schema(module)
    _commit(db, "Unable to delete field")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/{field_id}", status_code=status.HTTP_204_NO_CONTENT)
def legacy_delete_field(
    field_id: UUID,
    _: FieldWriteUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    _field(db, field_id)
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"code": "close_required", "message": "Use Close to close this field"},
    )


@router.post("/{field_id}/restore", response_model=FieldResponse)
def restore_field(
    field_id: UUID,
    user: FieldWriteUser,
    db: Annotated[Session, Depends(get_db)],
) -> Field:
    field = _field(db, field_id)
    if not field.is_deleted:
        raise _conflict("Field is not deleted")
    try:
        reopen_lifecycle(db, LifecycleTargetType.FIELD, field_id, user.id)
    except LifecycleError as error:
        raise HTTPException(status_code=int(error.status_code), detail=error.detail) from error
    return _field(db, field_id)


@module_fields_router.post(
    "/{module_id}/fields/reorder",
    response_model=list[FieldResponse],
)
def reorder_module_fields(
    module_id: UUID,
    payload: FieldReorder,
    _: FieldWriteUser,
    db: Annotated[Session, Depends(get_db)],
) -> list[Field]:
    module = _lock_active_module(db, module_id)
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
    original_positions = {field.id: field.position for field in fields}
    temporary_start = max(field.position for field in fields) + len(fields) + 1
    for position, field_id in enumerate(payload.field_ids):
        fields_by_id[field_id].position = temporary_start + position
    db.flush()
    for position, field_id in enumerate(payload.field_ids):
        fields_by_id[field_id].position = position
    if any(
        fields_by_id[field_id].position != original_positions[field_id]
        for field_id in payload.field_ids
    ):
        _invalidate_module_schema(module)
    _commit(db, "Field position unavailable")
    return [fields_by_id[field_id] for field_id in payload.field_ids]
