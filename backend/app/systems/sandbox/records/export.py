"""Bounded export snapshots, completed and authorized before response bytes are released."""

import csv
import io
import math
import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from babel.dates import format_date, format_datetime
from fastapi import HTTPException
from sqlalchemy import Engine, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.organization_scope import apply_connection_scope
from app.systems.access.policy.checks import module_hidden
from app.systems.access.users.models import User
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.openview.views.access import visible_to
from app.systems.openview.views.models import SavedView
from app.systems.sandbox.designs.date_values import parse_datetime
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.display import (
    UNAVAILABLE_OPTION,
    UNAVAILABLE_USER,
    FieldDisplayResolver,
)
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.query import (
    RecordProjection,
    compile_query,
    projected_record,
    projected_record_query,
    validate_definition,
)
from app.systems.sandbox.records.query_schemas import ExportRequest

MAX_ROWS = 10_000
MAX_BYTES = 8 * 1024 * 1024


@dataclass(frozen=True)
class ExportContext:
    module_name: str
    view_name: str | None
    actor_name: str
    generated_at: datetime
    timezone: str
    theme: str
    filter_summary: str


def limit_exceeded() -> HTTPException:
    return HTTPException(
        422,
        detail={
            "code": "export_limit_exceeded",
            "message": "Export exceeds 10,000 rows or 8 MiB; narrow the filters",
        },
    )


def safe_text(value: str) -> str:
    if value and (value[0] in "\t\r\n" or value.lstrip().startswith(("=", "+", "-", "@"))):
        return "'" + value
    return value


def format_cell(
    value: Any,
    field: Field,
    timezone: str,
    locale: str,
    resolver: FieldDisplayResolver | None = None,
) -> str:
    if value is None:
        return ""
    if field.type == FieldType.DATE:
        return format_date(date.fromisoformat(value), locale=locale.replace("-", "_"))
    if field.type == FieldType.DATETIME:
        parsed = parse_datetime(value)
        if parsed is None:
            raise ValueError("Date/Time record value is invalid")
        instant = parsed.astimezone(ZoneInfo(timezone))
        displayed = format_datetime(
            instant, locale=locale.replace("-", "_"), tzinfo=ZoneInfo(timezone)
        )
        offset = instant.strftime("%z")
        return f"{displayed} UTC{offset[:3]}:{offset[3:]}"
    if field.type in {FieldType.NUMBER, FieldType.DECIMAL, FieldType.INTEGER}:
        return str(value)
    if field.type == FieldType.BOOLEAN:
        return "true" if value else "false"
    if field.type == FieldType.SELECT:
        if resolver is not None:
            return safe_text(resolver.label(field, value))
        label = next(
            (
                option["label"]
                for option in field.config.get("options", [])
                if option.get("id") == value
            ),
            UNAVAILABLE_OPTION,
        )
        return safe_text(label)
    if field.type == FieldType.USER:
        return safe_text(resolver.label(field, value) if resolver is not None else UNAVAILABLE_USER)
    return safe_text(str(value))


def xlsx_cell(
    value: Any, field: Field, timezone: str, resolver: FieldDisplayResolver | None = None
) -> str | int | float | bool | date | datetime | None:
    """Keep Excel values typed without applying CSV's visible apostrophe prefix."""
    if value is None:
        return None
    if field.type == FieldType.DATE:
        return date.fromisoformat(value)
    if field.type == FieldType.DATETIME:
        parsed = parse_datetime(value)
        if parsed is None:
            raise ValueError("Date/Time record value is invalid")
        return parsed.astimezone(ZoneInfo(timezone)).replace(tzinfo=None)
    if field.type == FieldType.INTEGER:
        return int(value)
    if field.type == FieldType.NUMBER:
        return float(value)
    if field.type == FieldType.DECIMAL:
        precise = Decimal(str(value))
        number = float(precise)
        # The pinned XlsxWriter serializes numeric cells with this precision.
        return (
            number
            if math.isfinite(number) and Decimal(f"{number:.16G}") == precise
            else str(value)
        )
    if field.type == FieldType.BOOLEAN:
        return bool(value)
    if field.type in {FieldType.SELECT, FieldType.USER}:
        if resolver is not None:
            return resolver.label(field, value)
        if field.type == FieldType.USER:
            return UNAVAILABLE_USER
        return next(
            (
                option["label"]
                for option in field.config.get("options", [])
                if option.get("id") == value
            ),
            UNAVAILABLE_OPTION,
        )
    return str(value)


def encode_csv(
    rows: Iterable[Record | RecordProjection],
    fields: list[Field],
    timezone: str,
    locale: str,
    resolver: FieldDisplayResolver | None = None,
    *,
    include_record_id: bool = True,
) -> tuple[bytes, int]:
    result = bytearray()
    row_buffer = io.StringIO(newline="")
    writer = csv.writer(row_buffer)

    def append_row(cells: list[str]) -> None:
        row_buffer.seek(0)
        row_buffer.truncate()
        writer.writerow(cells)
        encoded = row_buffer.getvalue().encode("utf-8")
        if len(result) + len(encoded) > MAX_BYTES:
            raise limit_exceeded()
        result.extend(encoded)

    append_row(
        [
            *(["Record ID"] if include_record_id else []),
            *[safe_text(field.name) for field in fields],
        ]
    )
    count = 0
    for row in rows:
        count += 1
        if count > MAX_ROWS:
            raise limit_exceeded()
        append_row(
            [
                *([str(row.id)] if include_record_id else []),
                *[
                    format_cell(row.data.get(str(field.id)), field, timezone, locale, resolver)
                    for field in fields
                ],
            ]
        )
    return bytes(result), count


def export_filename(context: ExportContext, format: str) -> str:
    def component(value: str, fallback: str) -> str:
        ascii_name = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
        return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")[:80] or fallback

    local_date = context.generated_at.astimezone(ZoneInfo(context.timezone)).date()
    module = component(context.module_name, "module")
    view = component(context.view_name or "records", "records")
    return f"{module}-{view}-{local_date.isoformat()}.{format}"


def export_context(
    snapshot: Session,
    payload: ExportRequest,
    reader: User,
    profile: WorkspaceProfile,
    fields: dict[UUID, Field],
) -> ExportContext:
    module = snapshot.get(Module, payload.module_id)
    if module is None:
        raise module_hidden()
    view_name = None
    if payload.view_id is not None:
        view = snapshot.scalar(
            select(SavedView).where(
                SavedView.id == payload.view_id,
                SavedView.module_id == payload.module_id,
                SavedView.is_deleted.is_(False),
                visible_to(snapshot, reader),
            )
        )
        if view is None:
            raise HTTPException(404, detail="View not found")
        view_name = view.name
    summary = (
        "; ".join(
            f"{fields[predicate.field_id].name} {predicate.operator}"
            + (f" {predicate.value}" if predicate.value is not None else "")
            for predicate in payload.definition.filters
        )
        or "None"
    )
    if payload.definition.search:
        summary += f"; Search: {payload.definition.search}"
    return ExportContext(
        module.module_name,
        view_name,
        reader.display_name or reader.username,
        utc_now(),
        profile.timezone,
        profile.theme,
        summary,
    )


def export_snapshot(
    engine: Engine, payload: ExportRequest, *, reader_id: UUID, org_id: UUID | None
) -> tuple[bytes, int, str]:
    with engine.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
        if org_id is not None:
            apply_connection_scope(connection, org_id)
        with Session(bind=connection) as snapshot:
            reader = snapshot.get(User, reader_id)
            if reader is None:
                raise module_hidden()
            fields = validate_definition(
                snapshot, payload.module_id, payload.definition, reader=reader
            )
            profile = snapshot.scalars(
                select(WorkspaceProfile).join(Module, Module.org_id == WorkspaceProfile.id)
                .where(Module.id == payload.module_id)
            ).one_or_none()
            if profile is None:
                raise HTTPException(503, detail="Workspace configuration is unavailable")
            if not payload.definition.columns and not payload.include_record_id:
                raise HTTPException(
                    422,
                    detail={
                        "code": "export_no_columns",
                        "message": "Choose at least one export column",
                    },
                )
            context = export_context(snapshot, payload, reader, profile, fields)
            statement = projected_record_query(
                compile_query(payload.module_id, payload.definition, fields),
                payload.definition,
            ).limit(
                MAX_ROWS + 1,
            )
            rows = (
                projected_record(row)
                for row in snapshot.execute(statement.execution_options(yield_per=100))
            )
            selected_fields = [fields[ref.field_id] for ref in payload.definition.columns]
            resolver = FieldDisplayResolver(snapshot, payload.module_id, selected_fields)
            if payload.format == "xlsx":
                from app.systems.sandbox.records.export_xlsx import encode_xlsx

                content, count = encode_xlsx(rows, selected_fields, payload, context, resolver)
            else:
                content, count = encode_csv(
                    rows,
                    selected_fields,
                    profile.timezone,
                    profile.locale,
                    resolver,
                    include_record_id=payload.include_record_id,
                )
            return content, count, export_filename(context, payload.format)


def commit_export_event(db: Session, actor_id: UUID, payload: ExportRequest, rows: int) -> None:
    try:
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="records.export.authorized",
                source="records",
                operation_id=uuid7(),
                actor_id=actor_id,
                subject_id=payload.module_id,
                outcome=SecurityEventOutcome.SUCCESS,
                metadata={
                    "format": payload.format,
                    "row_count": rows,
                    "column_count": len(payload.definition.columns)
                    + int(payload.include_record_id),
                    "filter_count": len(payload.definition.filters),
                    "view_id": str(payload.view_id) if payload.view_id is not None else None,
                    "filters": [
                        {"field_id": str(predicate.field_id), "operator": predicate.operator}
                        for predicate in payload.definition.filters
                    ],
                },
            ),
        )
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(503, detail="Unable to record export authorization") from error
