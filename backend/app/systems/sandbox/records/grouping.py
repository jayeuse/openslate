"""Bounded record groups for OpenView layouts."""

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.common.listing.schemas import PaginationMetadata
from app.core.config import get_settings
from app.core.config.development import is_relaxed_development
from app.systems.access.users.models import User
from app.systems.sandbox.designs.date_values import parse_datetime
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.query import (
    compile_query,
    field_expression,
    projected_record_query,
    projected_record_response,
    validate_definition,
)
from app.systems.sandbox.records.query_schemas import (
    GroupedRecordQuery,
    GroupedRecordResponse,
    GroupValueSelector,
    RecordGroup,
    UnspecifiedGroupSelector,
)


def _group_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, Decimal):
        return format(value, "f")
    return str(value)


def _typed_group_value(field: Field, value: str) -> Any:
    try:
        if field.type in {FieldType.NUMBER, FieldType.DECIMAL, FieldType.INTEGER}:
            numeric = Decimal(value)
            if numeric.is_finite():
                return numeric
        elif field.type == FieldType.DATE:
            parsed_date = date.fromisoformat(value)
            if parsed_date.isoformat() == value:
                return parsed_date
        elif field.type == FieldType.DATETIME:
            parsed_datetime = parse_datetime(value)
            if parsed_datetime is not None:
                return parsed_datetime
        elif field.type == FieldType.BOOLEAN:
            if value in {"true", "false"}:
                return value == "true"
        else:
            return value
    except (InvalidOperation, ValueError):
        pass
    raise HTTPException(422, detail="Group value does not match the field type")


def _ensure_group_value_selectable(payload: GroupedRecordQuery, value: str) -> None:
    settings = get_settings()
    if is_relaxed_development(settings):
        return
    selected_request = payload.model_copy(
        update={"selected_group": GroupValueSelector(kind="value", value=value)}
    )
    request_size = len(selected_request.model_dump_json().encode("utf-8"))
    if request_size > settings.request_body_max_bytes:
        raise HTTPException(
            422,
            detail={
                "code": "group_value_not_selectable",
                "message": "A group value exceeds the request body limit for member queries",
            },
        )


def query_grouped_records(
    db: Session, payload: GroupedRecordQuery, *, reader: User
) -> GroupedRecordResponse:
    fields = validate_definition(
        db,
        payload.module_id,
        payload.definition,
        reader=reader,
        extra_references=(payload.group_by,),
    )
    expression = field_expression(fields[payload.group_by.field_id])
    base_query = compile_query(payload.module_id, payload.definition, fields).order_by(None)
    groups_query = (
        base_query.with_only_columns(
            expression.label("value"),
            func.count(Record.id).label("count"),
        )
        .group_by(expression)
        .order_by(expression.asc().nulls_last())
    )
    group_count = (
        db.scalar(select(func.count()).select_from(groups_query.order_by(None).subquery())) or 0
    )
    rows = db.execute(groups_query.limit(payload.group_limit).offset(payload.group_offset)).all()
    groups = [
        RecordGroup(
            value=_group_value(row.value),
            label="Unspecified" if row.value is None else _group_value(row.value) or "",
            count=row.count,
        )
        for row in rows
    ]
    for group in groups:
        if group.value is not None:
            _ensure_group_value_selectable(payload, group.value)
    selected_group = payload.selected_group
    items = []
    pagination = None
    if selected_group is not None:
        if isinstance(selected_group, UnspecifiedGroupSelector):
            member_filter = expression.is_(None)
        else:
            assert isinstance(selected_group, GroupValueSelector)
            member_filter = expression == _typed_group_value(
                fields[payload.group_by.field_id], selected_group.value
            )
        members_query = compile_query(payload.module_id, payload.definition, fields).where(
            member_filter
        )
        member_total = (
            db.scalar(select(func.count()).select_from(members_query.order_by(None).subquery()))
            or 0
        )
        projected_members = projected_record_query(members_query, payload.definition)
        member_rows = db.execute(
            projected_members.limit(payload.limit).offset(payload.offset)
        ).all()
        items = [projected_record_response(row) for row in member_rows]
        pagination = PaginationMetadata(
            limit=payload.limit,
            offset=payload.offset,
            count=len(items),
            total=member_total,
            has_more=payload.offset + len(items) < member_total,
        )
    return GroupedRecordResponse(
        items=items,
        pagination=pagination,
        groups=groups,
        group_pagination={
            "limit": payload.group_limit,
            "offset": payload.group_offset,
            "count": len(groups),
            "total": group_count,
            "has_more": payload.group_offset + len(groups) < group_count,
        },
        selected_group=selected_group,
    )
