"""Relationship mutation and cardinality coordination."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import Select, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.errors import (
    RelationshipConflict,
    RelationshipInvalid,
    RelationshipNotFound,
    RelationshipUnavailable,
)
from app.systems.sandbox.relationships.locking import (
    _active_entity,
    _load_create_dependencies,
    _lock_relationship_rows,
    _nowait,
    validate_relationship_modules,
)
from app.systems.sandbox.relationships.models import RelationshipEdge
from app.systems.sandbox.relationships.projection import get_relationship, relationship_response
from app.systems.sandbox.relationships.schemas import RelationshipResponse


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


def _commit_response(db: Session, edge: RelationshipEdge, message: str) -> RelationshipResponse:
    """Snapshot flushed values while locked; return only after the commit succeeds."""
    try:
        db.flush()
        response = relationship_response(edge)
    except IntegrityError as error:
        db.rollback()
        raise RelationshipConflict(message) from error
    except OperationalError as error:
        db.rollback()
        raise RelationshipUnavailable(
            "Relationship operation is temporarily unavailable"
        ) from error
    _commit(db, message)
    return response


def create_relationship(
    db: Session,
    field_id: UUID,
    source_record_id: UUID,
    target_record_id: UUID,
) -> RelationshipResponse:
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

    if (
        field.relationship_multiple_targets is False
        and _find_active_edge(db, field.id, source_record_id=source.id) is not None
    ):
        raise RelationshipConflict("Source already has a relationship target")
    if (
        field.relationship_multiple_sources is False
        and _find_active_edge(db, field.id, target_record_id=target.id) is not None
    ):
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
    return _commit_response(db, edge, "Relationship cardinality or uniqueness conflict")


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
) -> RelationshipResponse | None:
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
        return relationship_response(current)
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
    return _commit_response(db, replacement, "Unable to assign relationship")


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
        edges = list(db.scalars(_active_edge_statement(field.id, for_update=False)).all())
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


__all__ = [
    "assign_relationship",
    "create_relationship",
    "unlink_relationship",
    "validate_cardinality_change",
]
