"""Bounded CSV generation, fully completed before any response bytes are released."""

import csv
import io
from collections.abc import Iterable
from datetime import date, datetime
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from babel.dates import format_date, format_datetime
from fastapi import HTTPException
from sqlalchemy import Engine, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.query import compile_query, validate_definition
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


def format_cell(value: Any, field: Field, timezone: str, locale: str) -> str:
    if value is None:
        return ""
    if field.type == FieldType.DATE:
        return format_date(date.fromisoformat(value), locale=locale.replace("-", "_"))
    if field.type == FieldType.DATETIME:
        instant = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(
            ZoneInfo(timezone)
        )
        displayed = format_datetime(
            instant, locale=locale.replace("-", "_"), tzinfo=ZoneInfo(timezone)
        )
        offset = instant.strftime("%z")
        return f"{displayed} UTC{offset[:3]}:{offset[3:]}"
    if field.type in {FieldType.NUMBER, FieldType.DECIMAL, FieldType.INTEGER}:
        return str(value)
    if field.type == FieldType.BOOLEAN:
        return "true" if value else "false"
    return safe_text(str(value))


def encode_csv(
    rows: Iterable[Record], fields: list[Field], timezone: str, locale: str
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
                    format_cell(row.data.get(str(field.id)), field, timezone, locale)
                    for field in fields
                ],
            ]
        )
    return bytes(result), count


def export_snapshot(engine: Engine, payload: RecordQuery) -> tuple[bytes, int]:
    with engine.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
        with Session(bind=connection) as snapshot:
            fields = validate_definition(snapshot, payload.module_id, payload.definition)
            profile = snapshot.scalar(
                select(WorkspaceProfile).where(WorkspaceProfile.singleton_key.is_(True))
            )
            if profile is None:
                raise HTTPException(503, detail="Workspace configuration is unavailable")
            statement = compile_query(payload.module_id, payload.definition, fields).limit(
                MAX_ROWS + 1
            )
            rows = snapshot.scalars(statement.execution_options(yield_per=100))
            return encode_csv(
                rows,
                [fields[ref.field_id] for ref in payload.definition.columns],
                profile.timezone,
                profile.locale,
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
