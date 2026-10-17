"""Bounded CSV conversion and creation through the ordinary record pipeline."""

import json
import re
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from hashlib import sha256
from math import isfinite
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.record_triggers.outbox import enqueue_record_event
from app.systems.sandbox.records.assignment_notifications import notify_record_assignments
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.mutation_validation import (
    RecordValidationError,
    RecordValidationIssue,
    prepare_record_creation,
)


@dataclass
class PreparedImportRow:
    row_number: int
    data: dict[str, Any]
    issues: list[RecordValidationIssue] = dataclass_field(default_factory=list)
    record_id: UUID | None = None


def creation_schema_digest(fields: list[Field]) -> str:
    schema = [
        {
            "id": str(field.id),
            "name": field.name,
            "type": field.type,
            "required": field.required,
            "position": field.position,
            "config": field.config,
        }
        for field in sorted(fields, key=lambda item: (item.position, str(item.id)))
        if not field.is_deleted and FieldType(field.type) is not FieldType.RELATIONSHIP
    ]
    return sha256(json.dumps(schema, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def selected_import_fields(
    fields: list[Field], mapping: list[tuple[int, UUID]], defaults: dict[str, Any]
) -> dict[int, Field]:
    active = {
        str(field.id): field
        for field in fields
        if not field.is_deleted and FieldType(field.type) is not FieldType.RELATIONSHIP
    }
    if any(str(field_id) not in active for _, field_id in mapping) or set(defaults) - active.keys():
        raise ValueError("Mapping and defaults must use active primitive fields in this module")
    return {column: active[str(field_id)] for column, field_id in mapping}


def _converted_cell(field: Field, cell: str) -> Any:
    kind = FieldType(field.type)
    if kind in {FieldType.TEXT, FieldType.LONG_TEXT, FieldType.EMAIL, FieldType.URL}:
        return cell
    if not cell.strip():
        return None
    if kind is FieldType.INTEGER:
        if re.fullmatch(r"[+-]?[0-9]+", cell.strip()) is None:
            raise ValueError("Integer must be a whole base-10 number")
        try:
            return int(cell.strip(), 10)
        except ValueError as error:
            raise ValueError("Integer must be a whole base-10 number") from error
    if kind is FieldType.NUMBER:
        try:
            number = float(cell)
        except ValueError as error:
            raise ValueError("Number must be finite") from error
        if not isfinite(number):
            raise ValueError("Number must be finite")
        return number
    if kind is FieldType.BOOLEAN:
        value = cell.strip().lower()
        if value not in {"true", "false"}:
            raise ValueError("Boolean must be true or false")
        return value == "true"
    if kind is FieldType.USER:
        try:
            return str(UUID(cell))
        except ValueError as error:
            raise ValueError("User must be a UUID") from error
    if kind is FieldType.SELECT:
        options = field.config.get("options", [])
        if not isinstance(options, list):
            raise ValueError("Select has invalid options")
        if any(isinstance(option, dict) and option.get("id") == cell for option in options):
            return cell
        matches = [
            option.get("id")
            for option in options
            if isinstance(option, dict) and option.get("label") == cell
        ]
        if len(matches) > 1:
            raise ValueError("Select label is ambiguous")
        if len(matches) != 1:
            raise ValueError("Select must match an option ID or label")
        return matches[0]
    # Decimal/date/datetime retain the existing canonical/ISO validation rules.
    return cell


def prepare_import_rows(
    db: Session,
    module_id: UUID,
    fields: list[Field],
    selected: dict[int, Field],
    rows: list[tuple[int, list[str]]],
    defaults: dict[str, Any],
) -> list[PreparedImportRow]:
    prepared = []
    for row_number, cells in rows:
        data = dict(defaults)
        issues: list[RecordValidationIssue] = []
        for column, field in selected.items():
            try:
                data[str(field.id)] = _converted_cell(field, cells[column])
            except ValueError as error:
                if len(issues) < 20:
                    issues.append(
                        RecordValidationIssue(
                            "ambiguous_select"
                            if str(error) == "Select label is ambiguous"
                            else "invalid_field_value",
                            field.id,
                            str(error),
                        )
                    )
        if issues:
            prepared.append(PreparedImportRow(row_number, {}, issues))
            continue
        try:
            normalized = prepare_record_creation(db, module_id, data, fields)
        except RecordValidationError as error:
            prepared.append(PreparedImportRow(row_number, {}, list(error.issues)))
        else:
            prepared.append(PreparedImportRow(row_number, normalized))
    return prepared


def create_import_records(db: Session, module_id: UUID, rows: list[PreparedImportRow]) -> None:
    """Attach each valid row and its event; the route owns the single commit."""

    fields = list(db.scalars(select(Field).where(Field.module_id == module_id)))
    for row in rows:
        if row.issues:
            continue
        record = Record(org_id=fields[0].org_id, module_id=module_id, data=row.data)
        db.add(record)
        db.flush()
        enqueue_record_event(db, record, previous=None)
        notify_record_assignments(
            db,
            record,
            previous=None,
            fields=fields,
        )
        row.record_id = record.id
