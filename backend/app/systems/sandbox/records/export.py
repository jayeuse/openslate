"""Bounded CSV generation, fully completed before any response bytes are released."""

import csv
import io
from collections.abc import Iterable
from datetime import date
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from babel.dates import format_date, format_datetime
from fastapi import HTTPException
from sqlalchemy import Engine, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.checks import module_hidden
from app.systems.access.users.models import User
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.designs.date_values import parse_datetime
from app.systems.sandbox.fields.models import Field, FieldType
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
from app.systems.sandbox.records.query_schemas import RecordQuery

MAX_ROWS = 10_000
MAX_BYTES = 8 * 1024 * 1024


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


def encode_csv(
    rows: Iterable[Record | RecordProjection],
    fields: list[Field],
    timezone: str,
    locale: str,
    resolver: FieldDisplayResolver | None = None,
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

    append_row(["Record ID", *[safe_text(field.name) for field in fields]])
    count = 0
    for row in rows:
        count += 1
        if count > MAX_ROWS:
            raise limit_exceeded()
        append_row(
            [
                str(row.id),
                *[
                    format_cell(row.data.get(str(field.id)), field, timezone, locale, resolver)
                    for field in fields
                ],
            ]
        )
    return bytes(result), count


def export_snapshot(engine: Engine, payload: RecordQuery, *, reader_id: UUID) -> tuple[bytes, int]:
    with engine.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
        with Session(bind=connection) as snapshot:
            reader = snapshot.get(User, reader_id)
            if reader is None:
                raise module_hidden()
            fields = validate_definition(
                snapshot, payload.module_id, payload.definition, reader=reader
            )
            profile = snapshot.scalar(
                select(WorkspaceProfile).where(WorkspaceProfile.singleton_key.is_(True))
            )
            if profile is None:
                raise HTTPException(503, detail="Workspace configuration is unavailable")
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
            return encode_csv(
                rows,
                selected_fields,
                profile.timezone,
                profile.locale,
                FieldDisplayResolver(snapshot, payload.module_id, selected_fields),
            )


def commit_export_event(db: Session, actor_id: UUID, module_id: UUID, rows: int) -> None:
    try:
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="records.export.authorized",
                source="records",
                operation_id=uuid7(),
                actor_id=actor_id,
                subject_id=module_id,
                outcome=SecurityEventOutcome.SUCCESS,
                metadata={"row_count": rows},
            ),
        )
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(503, detail="Unable to record export authorization") from error
