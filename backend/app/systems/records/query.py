"""One typed SQL compiler for interactive records and CSV snapshots."""

from datetime import date, datetime
from decimal import Decimal
from typing import Any
from typing import cast as type_cast
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import Boolean, Date, DateTime, Numeric, String, cast, func, select
from sqlalchemy.orm import Session
from sqlalchemy.sql import Select
from sqlalchemy.sql.elements import ColumnElement

from app.common.listing.schemas import PaginationMetadata, StandardListResponse
from app.systems.fields.models import Field, FieldType
from app.systems.fields.validation import validate_field_value
from app.systems.modules.models import Module
from app.systems.records.models import Record
from app.systems.records.query_schemas import QueryDefinition, QueryFilter, RecordQuery
from app.systems.records.schemas import RecordResponse


def invalid_view(message: str = "A referenced field has changed; repair the view") -> HTTPException:
    return HTTPException(409, detail={"code": "view_invalid", "message": message})


def validate_definition(
    db: Session, module_id: UUID, definition: QueryDefinition
) -> dict[UUID, Field]:
    if db.get(Module, module_id) is None:
        raise invalid_view("The module no longer exists")
    fields = {
        field.id: field for field in db.scalars(select(Field).where(Field.module_id == module_id))
    }
    for reference in [*definition.columns, *definition.filters, *definition.sort]:
        field = fields.get(reference.field_id)
        if field is None or field.type != reference.expected_type:
            raise invalid_view()
    for predicate in definition.filters:
        comparison_value(fields[predicate.field_id], predicate)
    return fields


def comparison_value(field: Field, predicate: QueryFilter) -> Any:
    if predicate.operator in {"empty", "not_empty"}:
        return None
    # Filtering historical values must not enforce current input length/range/required rules.
    validator = Field(
        id=field.id,
        type=field.type,
        required=False,
        config=field.config if field.type == FieldType.SELECT else {},
    )
    values = predicate.value if isinstance(predicate.value, list) else [predicate.value]
    try:
        normalized = [validate_field_value(validator, value) for value in values]
    except ValueError as error:
        if field.type == FieldType.SELECT:
            raise invalid_view("A referenced select option is no longer valid") from error
        raise HTTPException(422, detail="Filter value does not match the field type") from error
    if field.type in {FieldType.NUMBER, FieldType.DECIMAL, FieldType.INTEGER}:
        normalized = [Decimal(str(value)) for value in normalized]
    elif field.type == FieldType.DATE:
        normalized = [date.fromisoformat(value) for value in normalized]
    elif field.type == FieldType.DATETIME:
        normalized = [datetime.fromisoformat(value.replace("Z", "+00:00")) for value in normalized]
    return normalized if isinstance(predicate.value, list) else normalized[0]


def field_expression(field: Field) -> ColumnElement[Any]:
    value = Record.data[str(field.id)].astext
    if field.type in {FieldType.NUMBER, FieldType.DECIMAL, FieldType.INTEGER}:
        return cast(value, Numeric())
    if field.type == FieldType.DATE:
        return cast(value, Date())
    if field.type == FieldType.DATETIME:
        return cast(value, DateTime(timezone=True))
    if field.type == FieldType.BOOLEAN:
        return cast(value, Boolean())
    return type_cast(ColumnElement[Any], value)


def literal_pattern(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def compile_query(
    module_id: UUID, definition: QueryDefinition, fields: dict[UUID, Field]
) -> Select[tuple[Record]]:
    statement = select(Record).where(Record.module_id == module_id)
    if definition.deleted != "include":
        statement = statement.where(Record.is_deleted.is_(definition.deleted == "only"))
    if definition.search:
        statement = statement.where(
            cast(Record.id, String).ilike(f"%{literal_pattern(definition.search)}%", escape="\\")
        )
    for predicate in definition.filters:
        field = fields[predicate.field_id]
        expression = field_expression(field)
        value = comparison_value(field, predicate)
        match predicate.operator:
            case "empty":
                condition = expression.is_(None)
            case "not_empty":
                condition = expression.is_not(None)
            case "contains" | "prefix":
                pattern = literal_pattern(value)
                pattern = f"%{pattern}%" if predicate.operator == "contains" else f"{pattern}%"
                condition = expression.ilike(pattern, escape="\\")
            case "in":
                condition = expression.in_(value)
            case "eq":
                condition = expression == value
            case "lt":
                condition = expression < value
            case "lte":
                condition = expression <= value
            case "gt":
                condition = expression > value
            case "gte":
                condition = expression >= value
        statement = statement.where(condition)
    ordering = []
    for sort in definition.sort:
        expression = field_expression(fields[sort.field_id])
        ordering.append(
            (expression.desc() if sort.direction == "desc" else expression.asc()).nulls_last()
        )
    if not ordering:
        ordering.append(Record.created_at.asc().nulls_last())
    return statement.order_by(*ordering, Record.id.asc())


def projected_record(record: Record, definition: QueryDefinition) -> RecordResponse:
    response = RecordResponse.model_validate(record)
    keys = {str(ref.field_id) for ref in definition.columns}
    response.data = {key: value for key, value in record.data.items() if key in keys}
    return response


def query_records(db: Session, payload: RecordQuery) -> StandardListResponse[RecordResponse]:
    fields = validate_definition(db, payload.module_id, payload.definition)
    statement = compile_query(payload.module_id, payload.definition, fields)
    total = db.scalar(select(func.count()).select_from(statement.order_by(None).subquery())) or 0
    rows = db.scalars(statement.limit(payload.limit).offset(payload.offset)).all()
    return StandardListResponse(
        items=[projected_record(row, payload.definition) for row in rows],
        pagination=PaginationMetadata(
            limit=payload.limit,
            offset=payload.offset,
            count=len(rows),
            total=total,
            has_more=payload.offset + len(rows) < total,
        ),
    )
