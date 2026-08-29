from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID

from sqlalchemy import Select, or_, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session, aliased, joinedload
from sqlalchemy.sql.elements import ColumnElement

from app.common.listing import (
    ListQuerySpec,
    execute_standard_list,
)
from app.core.database.session import AuditSession
from app.systems.fields.models import Field, FieldType
from app.systems.modules.models import Module
from app.systems.records.models import Record
from app.systems.relationships.models import RelationshipEdge
from app.systems.relationships.schemas import (
    RelationshipAvailability,
    RelationshipHiddenReason,
    RelationshipListRequest,
    RelationshipResponse,
    RelationshipSortField,
    RelationshipVisibility,
)


class RelationshipError(Exception):
    status_code = 409

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class RelationshipNotFound(RelationshipError):
    status_code = 404


class RelationshipInvalid(RelationshipError):
    status_code = 422


class RelationshipUnavailable(RelationshipError):
    status_code = 503


class RelationshipConflict(RelationshipError):
    status_code = 409


def _nowait(statement: Select[Any]) -> Select[Any]:
    return statement.execution_options(populate_existing=True).with_for_update(nowait=True)


def lock_row[ModelT](
    db: Session, model: type[ModelT], object_id: UUID
) -> ModelT | None:
    """Lock one lifecycle row without waiting behind another mutation."""

    try:
        return cast(
            ModelT | None,
            db.get(
                model,
                object_id,
                populate_existing=True,
                with_for_update={"nowait": True},
            ),
        )
    except OperationalError as error:
        db.rollback()
        raise RelationshipUnavailable(
            "Relationship operation is temporarily unavailable"
        ) from error


def lock_modules(db: Session, module_ids: Sequence[UUID]) -> dict[UUID, Module]:
    unique_ids = sorted(set(module_ids))
    if not unique_ids or not isinstance(db, AuditSession):
        return {}
    try:
        locked = list(
            db.scalars(
                _nowait(
                    select(Module)
                    .where(Module.id.in_(unique_ids))
                    .order_by(Module.id)
                )
            ).all()
        )
    except OperationalError as error:
        db.rollback()
        raise RelationshipUnavailable(
            "Relationship operation is temporarily unavailable"
        ) from error
    if len(locked) != len(unique_ids):
        raise RelationshipConflict("A relationship module is unavailable")
    return {module.id: module for module in locked}


def _validate_locked_modules(
    field: Field,
    source: Record,
    target: Record | None,
    modules: dict[UUID, Module],
    *,
    active_source_module: bool,
    active_target_module: bool,
) -> None:
    source_module = modules.get(field.module_id)
    target_module = (
        modules.get(field.relationship_target_module_id)
        if field.relationship_target_module_id is not None
        else None
    )
    if source_module is None or target_module is None:
        raise RelationshipConflict("Relationship module is unavailable")
    if active_source_module:
        _active_entity(source_module, "Source module")
    if active_target_module:
        _active_entity(target_module, "Target module")
    if target is not None and target.module_id != target_module.id:
        raise RelationshipConflict("Target record module does not match field")
    if source.module_id != source_module.id:
        raise RelationshipConflict("Source record module does not match field")
    if source_module.department_id != target_module.department_id:
        raise RelationshipConflict("Relationship records must be in the same department")


def _lock_relationship_rows(
    db: Session,
    field: Field,
    source: Record,
    target: Record | None,
    extra_records: Sequence[Record] = (),
    *,
    active_source_module: bool = True,
    active_target_module: bool = True,
) -> tuple[Field, Record, Record | None]:
    module_ids = [field.module_id]
    if field.relationship_target_module_id is not None:
        module_ids.append(field.relationship_target_module_id)
    module_ids.append(source.module_id)
    if target is not None:
        module_ids.append(target.module_id)
    module_ids.extend(record.module_id for record in extra_records)
    locked_modules = lock_modules(db, module_ids)

    if not isinstance(db, AuditSession):
        relationship_modules = {
            module.id: module
            for module in (
                getattr(field, "module", None),
                getattr(source, "module", None),
                getattr(target, "module", None) if target is not None else None,
            )
            if module is not None
        }
        _validate_locked_modules(
            field,
            source,
            target,
            relationship_modules,
            active_source_module=active_source_module,
            active_target_module=active_target_module,
        )
        return field, source, target

    try:
        locked_field = db.scalar(_nowait(select(Field).where(Field.id == field.id)))
        records = [source, *extra_records]
        if target is not None:
            records.append(target)
        record_ids = sorted({record.id for record in records})
        locked_records = list(
            db.scalars(
                _nowait(
                    select(Record)
                    .where(Record.id.in_(record_ids))
                    .order_by(Record.id)
                )
            ).all()
        )
        records_by_id = {record.id: record for record in locked_records}
        locked_source = records_by_id.get(source.id)
        locked_target = records_by_id.get(target.id) if target is not None else None
    except OperationalError as error:
        db.rollback()
        raise RelationshipUnavailable(
            "Relationship operation is temporarily unavailable"
        ) from error
    if (
        locked_field is None
        or locked_source is None
        or (target is not None and locked_target is None)
    ):
        raise RelationshipConflict("Relationship dependency is unavailable")
    _validate_locked_modules(
        locked_field,
        locked_source,
        locked_target,
        locked_modules,
        active_source_module=active_source_module,
        active_target_module=active_target_module,
    )
    return locked_field, locked_source, locked_target


def _active_entity(entity: Any, label: str) -> None:
    if entity is None or getattr(entity, "is_deleted", True):
        raise RelationshipConflict(f"{label} is not active")


def validate_relationship_modules(source_module: Module, target_module: Module) -> None:
    _active_entity(source_module, "Source module")
    _active_entity(target_module, "Target module")
    if source_module.department_id != target_module.department_id:
        raise RelationshipConflict("Relationship target must be in the same department")


def _load_create_dependencies(
    db: Session, field_id: UUID, source_id: UUID, target_id: UUID
) -> tuple[Field, Record, Record]:
    field = db.scalar(select(Field).where(Field.id == field_id))
    source = db.scalar(select(Record).where(Record.id == source_id))
    target = db.scalar(select(Record).where(Record.id == target_id))
    if field is None:
        raise RelationshipConflict("Relationship field is unavailable")
    if source is None or target is None:
        raise RelationshipConflict("Relationship record is unavailable")
    locked_field, locked_source, locked_target = _lock_relationship_rows(db, field, source, target)
    if locked_target is None:
        raise RelationshipConflict("Target record is unavailable")
    return locked_field, locked_source, locked_target


def _validate_dependencies(field: Field, source: Record, target: Record) -> None:
    _active_entity(field, "Relationship field")
    _active_entity(source, "Source record")
    _active_entity(target, "Target record")
    if FieldType(field.type) is not FieldType.RELATIONSHIP:
        raise RelationshipConflict("Field is not a relationship field")
    if source.id == target.id:
        raise RelationshipInvalid("Source and target records must differ")
    if source.module_id != field.module_id:
        raise RelationshipConflict("Source record module does not match field")
    if field.relationship_target_module_id != target.module_id:
        raise RelationshipConflict("Target record module does not match field")
    source_module = getattr(source, "module", None)
    target_module = getattr(target, "module", None)
    if source_module is not None and target_module is not None:
        validate_relationship_modules(source_module, target_module)


def _validate_assignment_source(field: Field, source: Record) -> None:
    _active_entity(field, "Relationship field")
    _active_entity(source, "Source record")
    if FieldType(field.type) is not FieldType.RELATIONSHIP:
        raise RelationshipConflict("Field is not a relationship field")
    if source.module_id != field.module_id:
        raise RelationshipConflict("Source record module does not match field")


def _active_edge_statement(
    field_id: UUID, *, for_update: bool = True
) -> Select[tuple[RelationshipEdge]]:
    statement = (
        select(RelationshipEdge)
        .where(
            RelationshipEdge.field_id == field_id,
            RelationshipEdge.is_deleted.is_(False),
        )
        .order_by(RelationshipEdge.id)
    )
    return _nowait(statement) if for_update else statement


def _find_active_edge(
    db: Session,
    field_id: UUID,
    *,
    source_record_id: UUID | None = None,
    target_record_id: UUID | None = None,
    for_update: bool = True,
) -> RelationshipEdge | None:
    statement = _active_edge_statement(field_id, for_update=for_update)
    if source_record_id is not None:
        statement = statement.where(RelationshipEdge.source_record_id == source_record_id)
    if target_record_id is not None:
        statement = statement.where(RelationshipEdge.target_record_id == target_record_id)
    try:
        return db.scalar(statement)
    except OperationalError as error:
        db.rollback()
        raise RelationshipUnavailable(
            "Relationship operation is temporarily unavailable"
        ) from error


def _commit(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise RelationshipConflict(message) from error
    except OperationalError as error:
        db.rollback()
        raise RelationshipUnavailable(
            "Relationship operation is temporarily unavailable"
        ) from error


def _locked_edge(db: Session, relationship_id: UUID) -> RelationshipEdge:
    try:
        edge = db.get(
            RelationshipEdge,
            relationship_id,
            populate_existing=True,
            with_for_update={"nowait": True},
        )
    except OperationalError as error:
        db.rollback()
        raise RelationshipUnavailable(
            "Relationship operation is temporarily unavailable"
        ) from error
    if edge is None:
        raise RelationshipNotFound("Relationship not found")
    return edge


def _refresh_edge(db: Session, edge: RelationshipEdge) -> None:
    try:
        db.refresh(edge)
    except OperationalError as error:
        db.rollback()
        raise RelationshipUnavailable(
            "Relationship operation is temporarily unavailable"
        ) from error


def create_relationship(
    db: Session,
    field_id: UUID,
    source_record_id: UUID,
    target_record_id: UUID,
) -> RelationshipEdge:
    field, source, target = _load_create_dependencies(
        db, field_id, source_record_id, target_record_id
    )
    _validate_dependencies(field, source, target)

    duplicate = _find_active_edge(
        db,
        field.id,
        source_record_id=source.id,
        target_record_id=target.id,
    )
    if duplicate is not None:
        raise RelationshipConflict("Relationship already exists")

    if field.relationship_multiple_targets is False and _find_active_edge(
        db, field.id, source_record_id=source.id
    ) is not None:
        raise RelationshipConflict("Source already has a relationship target")
    if field.relationship_multiple_sources is False and _find_active_edge(
        db, field.id, target_record_id=target.id
    ) is not None:
        raise RelationshipConflict("Target already has a relationship source")

    edge = RelationshipEdge(
        field_id=field.id,
        source_record_id=source.id,
        target_record_id=target.id,
        field=field,
        source_record=source,
        target_record=target,
    )
    db.add(edge)
    _commit(db, "Relationship cardinality or uniqueness conflict")
    _refresh_edge(db, edge)
    return edge


def get_relationship(db: Session, relationship_id: UUID) -> RelationshipEdge:
    edge = db.get(
        RelationshipEdge,
        relationship_id,
        options=(
            joinedload(RelationshipEdge.field).joinedload(Field.module),
            joinedload(RelationshipEdge.field).joinedload(Field.relationship_target_module),
            joinedload(RelationshipEdge.source_record).joinedload(Record.module),
            joinedload(RelationshipEdge.target_record).joinedload(Record.module),
        ),
    )
    if edge is None:
        raise RelationshipNotFound("Relationship not found")
    return edge


def _edge_hidden_reasons(edge: RelationshipEdge) -> list[RelationshipHiddenReason]:
    reasons: list[RelationshipHiddenReason] = []
    field = edge.field
    source = edge.source_record
    target = edge.target_record
    source_module = getattr(source, "module", None)
    target_module = getattr(target, "module", None)
    if field.is_deleted:
        reasons.append(RelationshipHiddenReason.FIELD_ARCHIVED)
    if source.is_deleted:
        reasons.append(RelationshipHiddenReason.SOURCE_RECORD_ARCHIVED)
    if target.is_deleted:
        reasons.append(RelationshipHiddenReason.TARGET_RECORD_ARCHIVED)
    if source_module is not None and source_module.is_deleted:
        reasons.append(RelationshipHiddenReason.SOURCE_MODULE_ARCHIVED)
    if target_module is not None and target_module.is_deleted:
        reasons.append(RelationshipHiddenReason.TARGET_MODULE_ARCHIVED)
    return reasons


def relationship_response(edge: RelationshipEdge) -> RelationshipResponse:
    reasons = _edge_hidden_reasons(edge)
    return RelationshipResponse.model_validate(
        {
            "id": edge.id,
            "field_id": edge.field_id,
            "source_record_id": edge.source_record_id,
            "target_record_id": edge.target_record_id,
            "created_at": edge.created_at,
            "updated_at": edge.updated_at,
            "deleted_at": edge.deleted_at,
            "is_deleted": edge.is_deleted,
            "performed_by": edge.performed_by,
            "visibility": (
                RelationshipVisibility.HIDDEN if reasons else RelationshipVisibility.AVAILABLE
            ),
            "hidden_reasons": reasons,
        }
    )


def unlink_relationship(db: Session, relationship_id: UUID) -> None:
    edge = get_relationship(db, relationship_id)
    field = edge.field
    source = edge.source_record
    target = edge.target_record
    if field is not None and source is not None and target is not None:
        locked_field, locked_source, _ = _lock_relationship_rows(
            db,
            field,
            source,
            target,
            # Clearing an existing link remains possible when its target has
            # been closed, but the field and source side must still be live.
            active_target_module=False,
        )
        _active_entity(locked_field, "Relationship field")
        _active_entity(locked_source, "Source record")
    edge = _locked_edge(db, relationship_id)
    if edge.is_deleted:
        raise RelationshipConflict("Relationship is already deleted")
    edge.is_deleted = True
    edge.deleted_at = datetime.now(UTC)
    _commit(db, "Unable to delete relationship")


def assign_relationship(
    db: Session,
    field_id: UUID,
    source_record_id: UUID,
    target_record_id: UUID | None,
) -> RelationshipEdge | None:
    field = db.scalar(select(Field).where(Field.id == field_id))
    source = db.scalar(select(Record).where(Record.id == source_record_id))
    if field is None or source is None:
        raise RelationshipConflict("Relationship dependency is unavailable")
    # Discover the previous target without taking an edge lock before the
    # canonical module -> field -> record -> edge lock sequence below.
    current = _find_active_edge(
        db,
        field_id,
        source_record_id=source_record_id,
        for_update=False,
    )
    target = (
        db.scalar(select(Record).where(Record.id == target_record_id))
        if target_record_id is not None
        else None
    )
    locked_field, locked_source, locked_target = _lock_relationship_rows(
        db,
        field,
        source,
        target or (current.target_record if current is not None else None),
        extra_records=(current.target_record,) if current is not None else (),
        active_target_module=target_record_id is not None,
    )
    _validate_assignment_source(locked_field, locked_source)
    current = _find_active_edge(db, field_id, source_record_id=source_record_id)
    if locked_field.relationship_multiple_targets is not False:
        raise RelationshipConflict("Atomic assignment requires a single-target field")
    if target_record_id is not None:
        if locked_target is None:
            raise RelationshipConflict("Target record is unavailable")
        target = locked_target
        _validate_dependencies(locked_field, locked_source, target)
    else:
        target = None

    if target_record_id is None:
        if current is None:
            return None
        current.is_deleted = True
        current.deleted_at = datetime.now(UTC)
        _commit(db, "Unable to clear relationship")
        return None

    if current is not None and target_record_id == current.target_record_id:
        current.field = locked_field
        current.source_record = locked_source
        current.target_record = locked_target or current.target_record
        return current
    if target is None:
        raise RelationshipConflict("Target record is unavailable")

    target_edge = _find_active_edge(
        db,
        field_id,
        target_record_id=target.id,
    )
    if (
        locked_field.relationship_multiple_sources is False
        and target_edge is not None
        and target_edge is not current
    ):
        raise RelationshipConflict("Target already has a relationship source")

    if current is not None:
        current.is_deleted = True
        current.deleted_at = datetime.now(UTC)
    replacement = RelationshipEdge(
        field_id=field_id,
        source_record_id=source_record_id,
        target_record_id=target.id,
        field=locked_field,
        source_record=locked_source,
        target_record=target,
    )
    db.add(replacement)
    _commit(db, "Unable to assign relationship")
    _refresh_edge(db, replacement)
    return replacement


def validate_cardinality_change(
    db: Session,
    field: Field,
    multiple_targets: bool | None,
    multiple_sources: bool | None,
) -> None:
    if FieldType(field.type) is not FieldType.RELATIONSHIP:
        return
    if multiple_targets is None and multiple_sources is None:
        return
    try:
        edges = list(
            db.scalars(
                _active_edge_statement(field.id, for_update=False)
            ).all()
        )
    except OperationalError as error:
        db.rollback()
        raise RelationshipUnavailable(
            "Relationship operation is temporarily unavailable"
        ) from error
    if multiple_targets is False:
        source_counts: dict[UUID, int] = {}
        for edge in edges:
            source_counts[edge.source_record_id] = source_counts.get(edge.source_record_id, 0) + 1
        if any(count > 1 for count in source_counts.values()):
            raise RelationshipConflict(
                "Existing relationships conflict with single-target cardinality"
            )
    if multiple_sources is False:
        target_counts: dict[UUID, int] = {}
        for edge in edges:
            target_counts[edge.target_record_id] = target_counts.get(edge.target_record_id, 0) + 1
        if any(count > 1 for count in target_counts.values()):
            raise RelationshipConflict(
                "Existing relationships conflict with single-source cardinality"
            )


def list_relationships(
    db: Session, params: RelationshipListRequest
) -> tuple[list[RelationshipResponse], Any]:
    source_record = aliased(Record)
    target_record = aliased(Record)
    source_module = aliased(Module)
    target_module = aliased(Module)
    statement = (
        select(RelationshipEdge)
        .join(Field, RelationshipEdge.field_id == Field.id)
        .join(source_record, RelationshipEdge.source_record_id == source_record.id)
        .join(target_record, RelationshipEdge.target_record_id == target_record.id)
        .join(source_module, Field.module_id == source_module.id)
        .join(target_module, Field.relationship_target_module_id == target_module.id)
    )
    if params.field_id is not None:
        statement = statement.where(RelationshipEdge.field_id == params.field_id)
    if params.source_record_id is not None:
        statement = statement.where(RelationshipEdge.source_record_id == params.source_record_id)
    if params.target_record_id is not None:
        statement = statement.where(RelationshipEdge.target_record_id == params.target_record_id)
    if params.incident_record_id is not None:
        statement = statement.where(
            or_(
                RelationshipEdge.source_record_id == params.incident_record_id,
                RelationshipEdge.target_record_id == params.incident_record_id,
            )
        )
    if params.source_module_id is not None:
        statement = statement.where(Field.module_id == params.source_module_id)
    if params.target_module_id is not None:
        statement = statement.where(
            Field.relationship_target_module_id == params.target_module_id
        )
    hidden = or_(
        Field.is_deleted.is_(True),
        source_record.is_deleted.is_(True),
        target_record.is_deleted.is_(True),
        source_module.is_deleted.is_(True),
        target_module.is_deleted.is_(True),
    )
    if params.availability is RelationshipAvailability.AVAILABLE:
        statement = statement.where(~hidden)
    elif params.availability is RelationshipAvailability.HIDDEN:
        statement = statement.where(hidden)

    spec = ListQuerySpec(
        sort_fields={
            RelationshipSortField.CREATED_AT: cast(ColumnElement[Any], RelationshipEdge.created_at),
            RelationshipSortField.UPDATED_AT: cast(ColumnElement[Any], RelationshipEdge.updated_at),
        },
        default_sort=RelationshipSortField.CREATED_AT,
        tie_breaker=cast(ColumnElement[Any], RelationshipEdge.id),
        deleted_field=cast(ColumnElement[bool], RelationshipEdge.is_deleted),
    )
    result = execute_standard_list(db, statement, params, spec)
    items = [relationship_response(edge) for edge in result.items]
    return items, result.pagination
