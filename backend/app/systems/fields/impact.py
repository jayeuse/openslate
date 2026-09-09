"""Bounded validation for existing records affected by field changes."""

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.fields.models import Field, FieldType
from app.systems.fields.validation import field_config, validate_field_value
from app.systems.records.models import Record

RECORD_IMPACT_BATCH_SIZE = 250


def validate_change_impact(
    db: Session,
    field: Field,
    field_type: FieldType,
    required: bool,
    config: dict[str, Any],
) -> dict[str, Any]:
    try:
        normalized_config = field_config(field_type, config)
    except ValueError as error:
        raise ValueError(str(error)) from error

    if (
        field_type == FieldType(field.type)
        and required == field.required
        and normalized_config == field.config
    ):
        return normalized_config

    candidate = Field(
        module_id=field.module_id,
        name=field.name,
        type=field_type,
        required=required,
        position=field.position,
        config=normalized_config,
    )
    candidate.id = field.id
    key = str(field.id)
    statement = (
        select(Record.data.has_key(key), Record.data[key])
        .where(
            Record.module_id == field.module_id,
            Record.is_deleted.is_(False),
        )
        .execution_options(stream_results=True, max_row_buffer=RECORD_IMPACT_BATCH_SIZE)
    )
    result = db.execute(statement).yield_per(RECORD_IMPACT_BATCH_SIZE)
    try:
        for has_value, value in result:
            if required and (not has_value or value is None):
                raise ValueError("Field change would invalidate active records")
            if has_value:
                try:
                    validate_field_value(candidate, value)
                except ValueError as error:
                    raise ValueError("Field change would invalidate active records") from error
    finally:
        result.close()
    return normalized_config
