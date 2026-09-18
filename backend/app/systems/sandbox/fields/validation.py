import re
from collections.abc import Callable, Sequence
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from math import isfinite
from typing import Any
from uuid import UUID

from app.systems.sandbox.fields.models import Field, FieldType

FieldValidator = Callable[[Any, Field], Any]

_DECIMAL_PATTERN = re.compile(r"-?(0|[1-9][0-9]*)(?:\.([0-9]+))?\Z")
_DATE_PATTERN = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")
_DATETIME_PATTERN = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})\Z"
)
_DECIMAL_MAX_LENGTH = 58
_DECIMAL_MAX_INTEGER_DIGITS = 38
_DECIMAL_MAX_FRACTIONAL_DIGITS = 18


def _canonical_decimal(raw_value: Any, label: str) -> str:
    if not isinstance(raw_value, str) or len(raw_value) > _DECIMAL_MAX_LENGTH:
        raise ValueError(f"Decimal {label} must be a valid decimal string")
    match = _DECIMAL_PATTERN.fullmatch(raw_value)
    if match is None:
        raise ValueError(f"Decimal {label} must be a valid decimal string")

    integer_part = match.group(1)
    fractional_part = match.group(2) or ""
    if len(integer_part) > _DECIMAL_MAX_INTEGER_DIGITS:
        raise ValueError(f"Decimal {label} has too many integer digits")
    if len(fractional_part) > _DECIMAL_MAX_FRACTIONAL_DIGITS:
        raise ValueError(f"Decimal {label} has too many fractional digits")

    fractional_part = fractional_part.rstrip("0")
    negative = raw_value.startswith("-") and not (
        integer_part == "0" and not fractional_part
    )
    canonical = ("-" if negative else "") + integer_part
    if fractional_part:
        canonical += f".{fractional_part}"
    return canonical


def _finite_numeric(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return not isinstance(value, float) or isfinite(value)


def _numeric_config(config: dict[str, Any]) -> dict[str, Any]:
    allowed = {"minimum", "maximum"}
    if set(config).difference(allowed):
        raise ValueError("Numeric fields only support minimum and maximum configuration")
    for key in set(config).intersection(allowed):
        if not _finite_numeric(config[key]):
            raise ValueError(f"Numeric field {key} must be a finite number")
    if "minimum" in config and "maximum" in config and config["minimum"] > config["maximum"]:
        raise ValueError("Numeric field minimum cannot exceed maximum")
    return config


def _decimal_config(config: dict[str, Any]) -> dict[str, Any]:
    allowed = {"minimum", "maximum"}
    if set(config).difference(allowed):
        raise ValueError("Decimal fields only support minimum and maximum configuration")

    normalized = dict(config)
    for key in set(config).intersection(allowed):
        if config[key] is not None:
            normalized[key] = _canonical_decimal(config[key], key)

    if normalized.get("minimum") is not None and normalized.get("maximum") is not None:
        try:
            if Decimal(normalized["minimum"]) > Decimal(normalized["maximum"]):
                raise ValueError("Decimal field minimum cannot exceed maximum")
        except InvalidOperation as error:
            raise ValueError("Decimal field bounds must be valid decimal strings") from error
    return normalized


def field_config(field_type: FieldType, config: dict[str, Any]) -> dict[str, Any]:
    if field_type is FieldType.SELECT:
        options = config.get("options")
        if set(config) != {"options"} or not isinstance(options, list) or not options:
            raise ValueError("Select fields require a non-empty options list")
        if any(not isinstance(option, str) or not option.strip() for option in options):
            raise ValueError("Select options must be non-empty strings")
        if len(options) != len(set(options)):
            raise ValueError("Select options must be unique")
    elif field_type in {FieldType.NUMBER, FieldType.INTEGER}:
        return _numeric_config(config)
    elif field_type is FieldType.DECIMAL:
        return _decimal_config(config)
    elif field_type is FieldType.TEXT:
        allowed = {"minLength", "maxLength"}
        if set(config).difference(allowed):
            raise ValueError("Text fields only support minLength and maxLength configuration")
        for key in set(config).intersection(allowed):
            value = config[key]
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"Text field {key} must be a nonnegative integer")
        if "minLength" in config and "maxLength" in config:
            if config["minLength"] > config["maxLength"]:
                raise ValueError("Text field minLength cannot exceed maxLength")
    elif config:
        raise ValueError("This field type does not support configuration")
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


def _validate_text(value: Any, field: Field) -> str:
    if not isinstance(value, str):
        raise ValueError(f"Field {field.id} must be text")
    if field.required and value == "":
        raise ValueError(f"Field {field.id} is required")
    minimum = field.config.get("minLength")
    maximum = field.config.get("maxLength")
    if minimum is not None and (isinstance(minimum, bool) or not isinstance(minimum, int)):
        raise ValueError(f"Field {field.id} has invalid text configuration")
    if maximum is not None and (isinstance(maximum, bool) or not isinstance(maximum, int)):
        raise ValueError(f"Field {field.id} has invalid text configuration")
    if minimum is not None and len(value) < minimum:
        raise ValueError(f"Field {field.id} is shorter than its minimum length")
    if maximum is not None and len(value) > maximum:
        raise ValueError(f"Field {field.id} exceeds its maximum length")
    return value


def _validate_number(value: Any, field: Field) -> int | float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or (isinstance(value, float) and not isfinite(value))
    ):
        raise ValueError(f"Field {field.id} must be a number")
    _validate_numeric_bounds(value, field)
    return value


def _validate_decimal(value: Any, field: Field) -> str:
    canonical = _canonical_decimal(value, "value")
    try:
        parsed = Decimal(canonical)
    except InvalidOperation as error:
        raise ValueError(f"Field {field.id} must be a decimal string") from error

    minimum = field.config.get("minimum")
    maximum = field.config.get("maximum")
    try:
        minimum_value = (
            Decimal(_canonical_decimal(minimum, "minimum")) if minimum is not None else None
        )
        maximum_value = (
            Decimal(_canonical_decimal(maximum, "maximum")) if maximum is not None else None
        )
    except (InvalidOperation, ValueError) as error:
        raise ValueError(f"Field {field.id} has invalid decimal configuration") from error
    if minimum_value is not None and parsed < minimum_value:
        raise ValueError(f"Field {field.id} is below its minimum")
    if maximum_value is not None and parsed > maximum_value:
        raise ValueError(f"Field {field.id} exceeds its maximum")
    return canonical


def _validate_integer(value: Any, field: Field) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"Field {field.id} must be an integer")
    _validate_numeric_bounds(value, field)
    return value


def _validate_boolean(value: Any, field: Field) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"Field {field.id} must be boolean")
    return value


def _validate_date(value: Any, field: Field) -> str:
    if not isinstance(value, str) or _DATE_PATTERN.fullmatch(value) is None:
        raise ValueError(f"Field {field.id} must be an ISO date")
    try:
        date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"Field {field.id} must be an ISO date") from error
    return value


def _validate_datetime(value: Any, field: Field) -> str:
    if not isinstance(value, str) or _DATETIME_PATTERN.fullmatch(value) is None:
        raise ValueError(f"Field {field.id} must be an ISO datetime")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"Field {field.id} must be an ISO datetime") from error
    return value


def _validate_select(value: Any, field: Field) -> str:
    options = field.config.get("options")
    if not isinstance(value, str) or not isinstance(options, list) or value not in options:
        raise ValueError(f"Field {field.id} must be one of the configured options")
    return value


def _validate_relationship(value: Any, field: Field) -> Any:
    raise ValueError(f"Relationship field {field.id} is managed separately")


def _validate_numeric_bounds(value: int | float, field: Field) -> None:
    minimum = field.config.get("minimum")
    maximum = field.config.get("maximum")
    try:
        if minimum is not None and value < minimum:
            raise ValueError(f"Field {field.id} is below its minimum")
        if maximum is not None and value > maximum:
            raise ValueError(f"Field {field.id} exceeds its maximum")
    except TypeError as error:
        raise ValueError(f"Field {field.id} has invalid numeric configuration") from error


FIELD_VALIDATORS: dict[FieldType, FieldValidator] = {
    FieldType.TEXT: _validate_text,
    FieldType.NUMBER: _validate_number,
    FieldType.DECIMAL: _validate_decimal,
    FieldType.INTEGER: _validate_integer,
    FieldType.BOOLEAN: _validate_boolean,
    FieldType.DATE: _validate_date,
    FieldType.DATETIME: _validate_datetime,
    FieldType.SELECT: _validate_select,
    FieldType.RELATIONSHIP: _validate_relationship,
}


def validate_field_value(field: Field, value: Any) -> Any:
    field_type = FieldType(field.type)
    if value is None and field_type is not FieldType.RELATIONSHIP:
        if field.required:
            raise ValueError(f"Field {field.id} is required")
        return None
    return FIELD_VALIDATORS[field_type](value, field)


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
