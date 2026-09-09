"""Relationship list loading and response projection."""

from typing import Any, cast
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, aliased, joinedload
from sqlalchemy.sql.elements import ColumnElement

from app.common.listing import ListQuerySpec, execute_standard_list
from app.systems.fields.models import Field
from app.systems.modules.models import Module
from app.systems.records.models import Record
from app.systems.relationships.errors import RelationshipNotFound
from app.systems.relationships.models import RelationshipEdge
from app.systems.relationships.schemas import (
    RelationshipAvailability,
    RelationshipHiddenReason,
    RelationshipListRequest,
    RelationshipResponse,
    RelationshipSortField,
    RelationshipVisibility,
)


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
        statement = statement.where(Field.relationship_target_module_id == params.target_module_id)
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


__all__ = [
    "get_relationship",
    "list_relationships",
    "relationship_response",
]
