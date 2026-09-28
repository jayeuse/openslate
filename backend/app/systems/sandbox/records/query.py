"""One typed SQL compiler for interactive records and CSV snapshots."""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from typing import cast as type_cast
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Numeric,
    String,
    and_,
    case,
    cast,
    func,
    literal,
    or_,
    select,
    true,
    type_coerce,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import Row
from sqlalchemy.orm import Session
from sqlalchemy.sql import Select
from sqlalchemy.sql.elements import ColumnElement

from app.common.listing.schemas import PaginationMetadata, StandardListResponse
from app.systems.access.policy.checks import module_hidden, module_level
from app.systems.access.users.models import User
from app.systems.sandbox.designs.date_values import parse_datetime
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.fields.validation import validate_field_value
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.query_schemas import (
    SEARCHABLE_FIELD_TYPES,
    TEXT_LIKE_FIELD_TYPES,
    FieldReference,
    QueryDefinition,
    QueryFilter,
    RecordQuery,
)
from app.systems.sandbox.records.schemas import RecordResponse


@dataclass(frozen=True, slots=True)
class RecordProjection:
    id: UUID
    module_id: UUID
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None
    data: dict[str, Any]


def invalid_view(message: str = "A referenced field has changed; repair the view") -> HTTPException:
    return HTTPException(409, detail={"code": "view_invalid", "message": message})


def validate_definition(
    db: Session,
    module_id: UUID,
    definition: QueryDefinition,
    extra_references: Sequence[FieldReference] = (),
    *,
    reader: User,
) -> dict[UUID, Field]:
    """Validate a record query for one module that ``reader`` can read.

    Every record read path compiles through this check, so a module the reader
    cannot read is hidden from all of them.
    """

    if module_level(db, reader, module_id) is None:
        raise module_hidden()
    return validate_fields(db, module_id, definition, extra_references)


def validate_fields(
    db: Session,
    module_id: UUID,
    definition: QueryDefinition,
    extra_references: Sequence[FieldReference] = (),
) -> dict[UUID, Field]:
    """Validate the field references of a record query, without an access check.

    Only a caller that acts as the workspace, such as a scheduled Report run, uses
    this directly. Every user read goes through :func:`validate_definition`.
    """

    if db.get(Module, module_id) is None:
        raise invalid_view("The module no longer exists")
    fields = {
        field.id: field for field in db.scalars(select(Field).where(Field.module_id == module_id))
    }
    for reference in [
        *definition.columns,
        *definition.filters,
        *definition.sort,
        *definition.search_fields,
    ]:
        field = fields.get(reference.field_id)
        if field is None or field.type != reference.expected_type:
            raise invalid_view()
    for reference in extra_references:
        field = fields.get(reference.field_id)
        if field is None or field.is_deleted or field.type != reference.expected_type:
            raise invalid_view()
    for reference in definition.search_fields:
        field = fields[reference.field_id]
        if field.is_deleted or field.type not in SEARCHABLE_FIELD_TYPES:
            raise invalid_view("Search fields must be active text or select fields")
    for predicate in definition.filters:
        comparison_value(fields[predicate.field_id], predicate)
    return fields


def comparison_value(field: Field, predicate: QueryFilter) -> Any:
    if predicate.operator in {"empty", "not_empty", "blank", "not_blank"}:
        return None
    if predicate.operator in {"contains", "prefix", "suffix"} and field.type in (
        *TEXT_LIKE_FIELD_TYPES,
        FieldType.SELECT,
    ):
        if not isinstance(predicate.value, str):
            raise HTTPException(422, detail="Filter value does not match the field type")
        return predicate.value
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
        normalized = [parse_datetime(value) for value in normalized]
    return normalized if isinstance(predicate.value, list) else normalized[0]


def field_expression(field: Field) -> ColumnElement[Any]:
    value = Record.data[str(field.id)].astext
    if field.type in {FieldType.NUMBER, FieldType.DECIMAL, FieldType.INTEGER}:
        return cast(value, Numeric())
    if field.type == FieldType.DATE:
        return cast(value, Date())
    if field.type == FieldType.DATETIME:
        has_explicit_timezone = value.op("~")(r"(Z|[+-][0-9]{2}:[0-9]{2})$")
        return type_cast(
            ColumnElement[Any],
            case(
                (has_explicit_timezone, cast(value, DateTime(timezone=True))),
                else_=func.timezone("UTC", cast(value, DateTime(timezone=False))),
            ),
        )
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
        pattern = f"%{literal_pattern(definition.search)}%"
        search_conditions = [cast(Record.id, String).ilike(pattern, escape="\\")]
        search_conditions.extend(
            field_expression(fields[reference.field_id]).ilike(pattern, escape="\\")
            for reference in definition.search_fields
        )
        statement = statement.where(or_(*search_conditions))
    filter_conditions = []
    for predicate in definition.filters:
        field = fields[predicate.field_id]
        expression = field_expression(field)
        value = comparison_value(field, predicate)
        condition: ColumnElement[bool]
        match predicate.operator:
            case "empty":
                condition = expression.is_(None)
            case "not_empty":
                condition = expression.is_not(None)
            case "blank":
                condition = (
                    or_(expression.is_(None), func.btrim(expression) == "")
                    if field.type in SEARCHABLE_FIELD_TYPES
                    else expression.is_(None)
                )
            case "not_blank":
                condition = (
                    and_(expression.is_not(None), func.btrim(expression) != "")
                    if field.type in SEARCHABLE_FIELD_TYPES
                    else expression.is_not(None)
                )
            case "contains" | "prefix" | "suffix":
                pattern = literal_pattern(value)
                if predicate.operator == "contains":
                    pattern = f"%{pattern}%"
                elif predicate.operator == "prefix":
                    pattern = f"{pattern}%"
                else:
                    pattern = f"%{pattern}"
                condition = expression.ilike(pattern, escape="\\")
            case "in":
                condition = expression.in_(value)
            case "eq":
                condition = expression == value
            case "neq":
                condition = expression != value
            case "lt":
                condition = expression < value
            case "lte":
                condition = expression <= value
            case "gt":
                condition = expression > value
            case "gte":
                condition = expression >= value
        filter_conditions.append(condition)
    if filter_conditions:
        statement = statement.where(
            and_(*filter_conditions) if definition.logic == "and" else or_(*filter_conditions)
        )
    return statement.order_by(*query_ordering(definition, fields))


def query_ordering(
    definition: QueryDefinition, fields: dict[UUID, Field]
) -> list[ColumnElement[Any]]:
    ordering: list[ColumnElement[Any]] = []
    for sort in definition.sort:
        expression = field_expression(fields[sort.field_id])
        ordering.append(
            (expression.desc() if sort.direction == "desc" else expression.asc()).nulls_last()
        )
    if not ordering:
        ordering.append(Record.created_at.asc().nulls_last())
    return [*ordering, Record.id.asc()]


def _record_data_projection(field_ids: Sequence[UUID]) -> ColumnElement[Any]:
    keys = tuple(dict.fromkeys(str(field_id) for field_id in field_ids))
    if not keys:
        return literal({}, type_=JSONB)

    entries = func.jsonb_each(Record.data).table_valued("key", "value").alias("record_data_keys")
    selected_data = (
        select(func.jsonb_object_agg(entries.c.key, entries.c.value))
        .select_from(entries)
        .where(entries.c.key.in_(keys))
        .correlate(Record)
        .scalar_subquery()
    )
    return type_coerce(
        func.coalesce(selected_data, literal({}, type_=JSONB)),
        JSONB,
    )


def projected_record_query(
    statement: Select[tuple[Record]],
    definition: QueryDefinition,
    *,
    extra_field_ids: Sequence[UUID] = (),
) -> Select[tuple[Any, ...]]:
    """Select Record metadata and only the definition's top-level JSON keys."""

    field_ids = [reference.field_id for reference in definition.columns]
    field_ids.extend(extra_field_ids)
    return statement.with_only_columns(
        Record.id.label("id"),
        Record.module_id.label("module_id"),
        Record.created_at.label("created_at"),
        Record.updated_at.label("updated_at"),
        Record.deleted_at.label("deleted_at"),
        Record.is_deleted.label("is_deleted"),
        Record.performed_by.label("performed_by"),
        _record_data_projection(field_ids).label("data"),
        maintain_column_froms=True,
    )


def projected_record(row: Row[tuple[Any, ...]]) -> RecordProjection:
    return RecordProjection(
        id=row.id,
        module_id=row.module_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
        deleted_at=row.deleted_at,
        is_deleted=row.is_deleted,
        performed_by=row.performed_by,
        data=row.data,
    )


def projected_record_response(row: Row[tuple[Any, ...]]) -> RecordResponse:
    return RecordResponse.model_validate(projected_record(row))


def _filtered_page(
    db: Session, payload: RecordQuery, fields: dict[UUID, Field]
) -> tuple[int, list[Row[tuple[Any, ...]]]]:
    # Reuse all matching IDs, not JSON values, for the exact total and page.
    matching = (
        compile_query(payload.module_id, payload.definition, fields)
        .with_only_columns(Record.id)
        .order_by(None)
        .cte("matching_record_ids")
        .prefix_with("MATERIALIZED", dialect="postgresql")
    )
    total = select(func.count().label("total")).select_from(matching).subquery("matching_total")
    paging_definition = payload.definition.model_copy(update={"filters": [], "search": None})
    statement = compile_query(payload.module_id, paging_definition, fields).join(
        matching, Record.id == matching.c.id
    )
    page = (
        projected_record_query(statement, payload.definition)
        .add_columns(
            func.row_number()
            .over(order_by=query_ordering(payload.definition, fields))
            .label("position")
        )
        .limit(payload.limit)
        .offset(payload.offset)
        .subquery("record_page")
    )
    # The outer join retains the total even when the requested page is empty.
    rows = db.execute(
        select(total.c.total, *page.c)
        .select_from(total.outerjoin(page, true()))
        .order_by(page.c.position)
    ).all()
    return int(rows[0].total), [row for row in rows if row.id is not None]


def query_records(
    db: Session, payload: RecordQuery, *, reader: User
) -> StandardListResponse[RecordResponse]:
    fields = validate_definition(db, payload.module_id, payload.definition, reader=reader)
    if payload.definition.filters or payload.definition.search:
        total, rows = _filtered_page(db, payload, fields)
    else:
        statement = compile_query(payload.module_id, payload.definition, fields)
        total = (
            db.scalar(select(func.count()).select_from(statement.order_by(None).subquery())) or 0
        )
        projected_statement = projected_record_query(statement, payload.definition)
        rows = list(db.execute(projected_statement.limit(payload.limit).offset(payload.offset)))
    return StandardListResponse(
        items=[projected_record_response(row) for row in rows],
        pagination=PaginationMetadata(
            limit=payload.limit,
            offset=payload.offset,
            count=len(rows),
            total=total,
            has_more=payload.offset + len(rows) < total,
        ),
    )
