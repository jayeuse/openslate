from collections.abc import Sequence
from datetime import date, datetime
from math import isfinite
from typing import Any
from uuid import UUID

from app.systems.fields.models import Field, FieldType


def field_config(field_type: FieldType, config: dict[str, Any]) -> dict[str, Any]:
    if field_type is FieldType.SELECT:
        options = config.get("options")
        if set(config) != {"options"} or not isinstance(options, list) or not options:
            raise ValueError("Select fields require a non-empty options list")
        if any(not isinstance(option, str) or not option.strip() for option in options):
            raise ValueError("Select options must be non-empty strings")
        if len(options) != len(set(options)):
            raise ValueError("Select options must be unique")
    elif field_type in {FieldType.NUMBER, FieldType.DECIMAL, FieldType.INTEGER}:
        allowed = {"minimum", "maximum"}
        if set(config).difference(allowed):
            raise ValueError("Numeric fields only support minimum and maximum configuration")
        for key in set(config).intersection(allowed):
            value = config[key]
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not isfinite(value)
            ):
                raise ValueError(f"Numeric field {key} must be a finite number")
        if "minimum" in config and "maximum" in config and config["minimum"] > config["maximum"]:
            raise ValueError("Numeric field minimum cannot exceed maximum")
    elif config:
        raise ValueError("Only select fields may have configuration")
    return config


def validate_relationship_metadata(field: Field) -> None:
    field_type = FieldType(field.type)
    metadata = (
        field.relationship_target_module_id,
        field.relationship_multiple_targets,
        field.relationship_multiple_sources,
    )
    if field_type is FieldType.RELATIONSHIP:
        if (
            field.relationship_target_module_id is None
            or not isinstance(field.relationship_multiple_targets, bool)
            or not isinstance(field.relationship_multiple_sources, bool)
            or field.required
            or field.config != {}
        ):
            raise ValueError("Relationship fields have invalid relationship metadata")
    elif any(value is not None for value in metadata):
        raise ValueError("Primitive fields have invalid relationship metadata")


def validate_module_schema(fields: Sequence[Field]) -> None:
    """Validate the persisted active fields that make up a module schema."""

    if not fields:
        raise ValueError("Module schemas require at least one active field")

    names: set[str] = set()
    positions: list[int] = []
    for field in fields:
        if not isinstance(field.name, str) or not field.name.strip():
            raise ValueError("Field names must be non-blank")
        if field.name in names:
            raise ValueError("Field names must be unique")
        names.add(field.name)

        if not isinstance(field.position, int) or isinstance(field.position, bool):
            raise ValueError("Field positions must be nonnegative integers")
        if field.position < 0:
            raise ValueError("Field positions must be nonnegative integers")
        positions.append(field.position)

        try:
            field_type = FieldType(field.type)
        except ValueError as error:
            raise ValueError("Field types are unsupported") from error
        if not isinstance(field.config, dict):
            raise ValueError("Field configuration must be an object")
        try:
            field_config(field_type, field.config)
            validate_relationship_metadata(field)
        except (TypeError, ValueError) as error:
            raise ValueError(str(error)) from error

    if sorted(positions) != list(range(len(fields))):
        raise ValueError("Field positions must be contiguous and zero-based")


def validate_field_value(field: Field, value: Any) -> None:
    if value is None:
        if field.required:
            raise ValueError(f"Field {field.id} is required")
        return

    field_type = FieldType(field.type)
    if field_type is FieldType.TEXT and not isinstance(value, str):
        raise ValueError(f"Field {field.id} must be text")
    if field_type in {FieldType.NUMBER, FieldType.DECIMAL} and (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or (isinstance(value, float) and not isfinite(value))
    ):
        raise ValueError(f"Field {field.id} must be a number")
    if field_type is FieldType.INTEGER and (isinstance(value, bool) or not isinstance(value, int)):
        raise ValueError(f"Field {field.id} must be an integer")
    if field_type is FieldType.BOOLEAN and not isinstance(value, bool):
        raise ValueError(f"Field {field.id} must be boolean")
    if field_type is FieldType.DATE:
        if not isinstance(value, str):
            raise ValueError(f"Field {field.id} must be an ISO date")
        try:
            date.fromisoformat(value)
        except ValueError as error:
            raise ValueError(f"Field {field.id} must be an ISO date") from error
    if field_type is FieldType.DATETIME:
        if not isinstance(value, str):
            raise ValueError(f"Field {field.id} must be an ISO datetime")
        try:
            datetime.fromisoformat(value)
        except ValueError as error:
            raise ValueError(f"Field {field.id} must be an ISO datetime") from error
        parsed = datetime.fromisoformat(value)
        if ("T" not in value and " " not in value) or parsed.tzinfo is None:
            raise ValueError(f"Field {field.id} must be an ISO datetime")
    if field_type is FieldType.SELECT:
        options = field.config.get("options")
        if not isinstance(value, str) or not isinstance(options, list) or value not in options:
            raise ValueError(f"Field {field.id} must be one of the configured options")

    if field_type in {FieldType.NUMBER, FieldType.DECIMAL, FieldType.INTEGER}:
        minimum = field.config.get("minimum")
        maximum = field.config.get("maximum")
        if minimum is not None and value < minimum:
            raise ValueError(f"Field {field.id} is below its minimum")
        if maximum is not None and value > maximum:
            raise ValueError(f"Field {field.id} exceeds its maximum")


def validate_record_data(data: dict[str, Any], fields: list[Field]) -> None:
    fields_by_id = {str(field.id): field for field in fields}
    unknown = set(data).difference(fields_by_id)
    if unknown:
        raise ValueError(f"Unknown or inactive field: {sorted(unknown)[0]}")

    for field in fields:
        key = str(field.id)
        if FieldType(field.type) is FieldType.RELATIONSHIP:
            if key in data:
                raise ValueError(f"Relationship field {field.id} is managed separately")
            continue
        if field.required and (key not in data or data[key] is None):
            raise ValueError(f"Field {field.id} is required")
        if key in data:
            validate_field_value(field, data[key])


def parse_field_key(key: str) -> UUID:
    try:
        return UUID(key)
    except ValueError as error:
        raise ValueError(f"Invalid field key: {key}") from error
