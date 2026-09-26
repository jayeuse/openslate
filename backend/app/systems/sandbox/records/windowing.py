"""Bounded Calendar and Timeline record windows for OpenView."""

from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from sqlalchemy import Date, and_, func, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.listing.schemas import PaginationMetadata
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.records.query import (
    compile_query,
    field_expression,
    projected_record_query,
    projected_record_response,
    validate_definition,
)
from app.systems.sandbox.records.query_schemas import (
    WindowRecordQuery,
    WindowRecordResponse,
)


def _workspace_timezone(db: Session) -> str:
    timezone_name = db.scalar(
        select(WorkspaceProfile.timezone).where(WorkspaceProfile.singleton_key.is_(True))
    )
    if not timezone_name:
        raise HTTPException(503, detail="Workspace configuration is unavailable")
    try:
        ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise HTTPException(503, detail="Workspace timezone is unavailable") from error
    return timezone_name


def _day_expression(field: Field, timezone_name: str | None) -> ColumnElement[Any]:
    expression = field_expression(field)
    if field.type == FieldType.DATETIME:
        assert timezone_name is not None
        return func.timezone(timezone_name, expression).cast(Date())
    return expression


def _window_condition(
    payload: WindowRecordQuery,
    fields: dict[UUID, Field],
    timezone_name: str | None,
) -> ColumnElement[bool]:
    if payload.mode == "calendar":
        assert payload.date_field is not None
        expression = _day_expression(fields[payload.date_field.field_id], timezone_name)
        if payload.scope == "undated":
            return expression.is_(None)
        assert payload.from_date is not None and payload.to_date is not None
        return and_(expression >= payload.from_date, expression <= payload.to_date)

    assert payload.start_field is not None and payload.end_field is not None
    start = _day_expression(fields[payload.start_field.field_id], timezone_name)
    end = _day_expression(fields[payload.end_field.field_id], timezone_name)
    if payload.scope == "unscheduled":
        return or_(start.is_(None), end.is_(None), start > end)
    assert payload.from_date is not None and payload.to_date is not None
    return and_(
        start <= end,
        start <= payload.to_date,
        end >= payload.from_date,
    )


def query_window_records(db: Session, payload: WindowRecordQuery) -> WindowRecordResponse:
    references = tuple(
        reference
        for reference in (payload.date_field, payload.start_field, payload.end_field)
        if reference is not None
    )
    fields = validate_definition(
        db,
        payload.module_id,
        payload.definition,
        extra_references=references,
    )
    timezone_name = (
        _workspace_timezone(db)
        if any(
            fields[reference.field_id].type == FieldType.DATETIME
            for reference in (*references, *payload.definition.columns)
        )
        else None
    )
    statement = compile_query(payload.module_id, payload.definition, fields).where(
        _window_condition(payload, fields, timezone_name)
    )
    total = db.scalar(
        select(func.count()).select_from(statement.order_by(None).subquery())
    ) or 0
    projected_statement = projected_record_query(statement, payload.definition)
    rows = db.execute(projected_statement.limit(payload.limit).offset(payload.offset)).all()
    return WindowRecordResponse(
        items=[projected_record_response(row) for row in rows],
        pagination=PaginationMetadata(
            limit=payload.limit,
            offset=payload.offset,
            count=len(rows),
            total=total,
            has_more=payload.offset + len(rows) < total,
        ),
        timezone=timezone_name,
    )
