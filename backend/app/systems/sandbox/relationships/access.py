"""Relationship access: a link is visible only when the user can read both ends.

Changing a link needs ``write`` on the source record's module and ``read`` on
the target record's module.
"""

from typing import Any
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import and_
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.systems.access.policy.checks import module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.scope import effective_levels, includes
from app.systems.access.users.models import User
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge


def readable_link_clause(
    db: Session, user: User, source_module_id: Any, target_module_id: Any
) -> ColumnElement[bool]:
    return and_(
        module_filter(db, user, AccessLevel.READ, source_module_id),
        module_filter(db, user, AccessLevel.READ, target_module_id),
    )


def _not_found(label: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{label} not found")


def require_readable_link(db: Session, user: User, edge: RelationshipEdge) -> None:
    access = effective_levels(db, user)
    for record in (edge.source_record, edge.target_record):
        if access.module_level(record.module_id) is None:
            raise _not_found("Relationship")


def require_link_change(
    db: Session,
    user: User,
    source_record_id: UUID,
    target_record_id: UUID | None,
    *,
    field_id: UUID | None = None,
) -> tuple[Record | None, Record | None, Field | None]:
    """A record the user cannot read is reported as missing.

    With ``field_id``, the field's target module must also be readable, because an
    assignment can replace or clear a link into it.

    Returns the rows it loaded. The session holds loaded rows only weakly, so a caller
    that keeps them while the write runs lets the write reuse them without a query.
    """

    # One resolution of the user's levels answers every module asked about below.
    access = effective_levels(db, user)
    source = db.get(Record, source_record_id)
    if source is not None:
        granted = access.module_level(source.module_id)
        if granted is None:
            raise _not_found("Record")
        if not includes(granted, AccessLevel.WRITE):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    target = db.get(Record, target_record_id) if target_record_id is not None else None
    if target is not None and access.module_level(target.module_id) is None:
        raise _not_found("Record")
    field = db.get(Field, field_id) if field_id is not None else None
    target_module_id = field.relationship_target_module_id if field is not None else None
    if target_module_id is not None and access.module_level(target_module_id) is None:
        raise _not_found("Field")
    return source, target, field
