import re
from collections.abc import Callable, Sequence
from decimal import Decimal, InvalidOperation
from math import isfinite
from typing import Any, cast
from uuid import UUID

from app.systems.sandbox.designs.date_values import date_in_range, valid_date, valid_datetime
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.numeric import numeric_matches_step

FieldValidator = Callable[[Any, Field], Any]

_DECIMAL_PATTERN = re.compile(r"-?(0|[1-9][0-9]*)(?:\.([0-9]+))?\Z")
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
    negative = raw_value.startswith("-") and not (integer_part == "0" and not fractional_part)
    canonical = ("-" if negative else "") + integer_part
    if fractional_part:
        canonical += f".{fractional_part}"
    return canonical


def _finite_numeric(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return not isinstance(value, float) or isfinite(value)


def _valid_email(value: str) -> bool:
    return re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value) is not None


def _valid_url(value: str) -> bool:
    return re.fullmatch(r"https?://[^\s/$.?#][^\s]*", value) is not None


def _numeric_config(field_type: FieldType, config: dict[str, Any]) -> dict[str, Any]:
    allowed = {"minimum", "maximum", "step", "defaultValue"}
    if set(config).difference(allowed):
        raise ValueError(
            "Numeric fields only support minimum, maximum, step, and defaultValue configuration"
        )
    for key in set(config).intersection(allowed):
        if key == "defaultValue" and config[key] is None:
            continue
        if not _finite_numeric(config[key]):
            raise ValueError(f"Numeric field {key} must be a finite number")
    normalized = dict(config)
    if field_type is FieldType.INTEGER:
        for key in allowed.intersection(normalized):
            value = normalized[key]
            if isinstance(value, float) and value.is_integer():
                normalized[key] = int(value)
    if (
        "minimum" in normalized
        and "maximum" in normalized
        and normalized["minimum"] > normalized["maximum"]
    ):
        raise ValueError("Numeric field minimum cannot exceed maximum")
    if "step" in normalized and (
        not _finite_numeric(normalized["step"]) or normalized["step"] <= 0
    ):
        raise ValueError("Numeric field step must be a positive finite number")
    if "defaultValue" in normalized and normalized["defaultValue"] is not None:
        default = normalized["defaultValue"]
        if not _finite_numeric(default):
            raise ValueError("Numeric field defaultValue must be a finite number")
        if normalized.get("minimum") is not None and default < normalized["minimum"]:
            raise ValueError("Numeric field defaultValue is below its minimum")
        if normalized.get("maximum") is not None and default > normalized["maximum"]:
            raise ValueError("Numeric field defaultValue exceeds its maximum")
        if normalized.get("step") is not None and not numeric_matches_step(
            default,
            normalized.get("minimum") or 0,
            normalized["step"],
        ):
            raise ValueError("Numeric field defaultValue does not match field step")
    if field_type is FieldType.INTEGER and any(
        isinstance(value, float) and not value.is_integer()
        for value in (
            normalized.get("minimum"),
            normalized.get("maximum"),
            normalized.get("step"),
            normalized.get("defaultValue"),
        )
    ):
        raise ValueError("Integer field configuration must use whole numbers")
    return normalized


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
        if (
            set(config).difference({"options", "defaultValue"})
            or not isinstance(options, list)
            or not options
        ):
            raise ValueError("Select fields require a non-empty options list")
        option_ids: list[str] = []
        labels: list[str] = []
        for option in options:
            if not isinstance(option, dict) or set(option) != {"id", "label"}:
                raise ValueError("Select options need IDs and labels")
            option_id, label = option["id"], option["label"]
            if not isinstance(option_id, str) or not isinstance(label, str) or not label.strip():
                raise ValueError("Select option IDs and labels must be non-empty strings")
            try:
                if str(UUID(option_id)) != option_id:
                    raise ValueError
            except ValueError as error:
                raise ValueError("Select option IDs must be canonical UUIDs") from error
            if len(label) > 100:
                raise ValueError("Select option labels may have at most 100 characters")
            option_ids.append(option_id)
            labels.append(label)
        if len(option_ids) != len(set(option_ids)) or len(labels) != len(set(labels)):
            raise ValueError("Select option IDs and labels must be unique")
        default = config.get("defaultValue")
        if default is not None and default not in option_ids:
            raise ValueError("Select defaultValue must be one of the configured options")
    elif field_type in {FieldType.NUMBER, FieldType.INTEGER}:
        return _numeric_config(field_type, config)
    elif field_type is FieldType.DECIMAL:
        return _decimal_config(config)
    elif field_type in {FieldType.TEXT, FieldType.LONG_TEXT, FieldType.EMAIL, FieldType.URL}:
        allowed = {"minLength", "maxLength", "defaultValue"}
        if set(config).difference(allowed):
            raise ValueError(
                "Text fields only support minLength, maxLength, and defaultValue configuration"
            )
        for key in {"minLength", "maxLength"}.intersection(config):
            value = config[key]
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"Text field {key} must be a nonnegative integer")
        if "minLength" in config and "maxLength" in config:
            if config["minLength"] > config["maxLength"]:
                raise ValueError("Text field minLength cannot exceed maxLength")
        default = config.get("defaultValue")
        if default is not None and not isinstance(default, str):
            raise ValueError("Text field defaultValue must be text")
        if isinstance(default, str):
            if config.get("minLength") is not None and len(default) < config["minLength"]:
                raise ValueError("Text field defaultValue is shorter than minLength")
            if config.get("maxLength") is not None and len(default) > config["maxLength"]:
                raise ValueError("Text field defaultValue exceeds maxLength")
            if field_type is FieldType.EMAIL and default and not _valid_email(default):
                raise ValueError("Email field defaultValue must be an email address")
            if field_type is FieldType.URL and default and not _valid_url(default):
                raise ValueError("URL field defaultValue must be an http or https URL")
    elif field_type in {FieldType.DATE, FieldType.DATETIME}:
        allowed = {"earliest", "latest", "defaultValue"}
        if set(config).difference(allowed):
            raise ValueError(
                "Date fields only support earliest, latest, and defaultValue configuration"
            )
        is_datetime = field_type is FieldType.DATETIME
        valid = valid_datetime if is_datetime else valid_date
        for key in allowed.intersection(config):
            value = config[key]
            if value is not None and (not isinstance(value, str) or not valid(value)):
                raise ValueError(f"Date field {key} must be valid ISO syntax")
        earliest = config.get("earliest")
        latest = config.get("latest")
        if earliest is not None and latest is not None and not date_in_range(
            earliest, None, latest, datetime_values=is_datetime
        ):
            raise ValueError("Date field earliest cannot exceed latest")
        default = config.get("defaultValue")
        if default is not None and not date_in_range(
            default, earliest, latest, datetime_values=is_datetime
        ):
            raise ValueError("Date field defaultValue must be within earliest and latest")
    elif field_type is FieldType.BOOLEAN:
        if set(config).difference({"defaultValue"}):
            raise ValueError("Boolean fields only support defaultValue configuration")
        if "defaultValue" in config and not isinstance(config["defaultValue"], bool):
            raise ValueError("Boolean field defaultValue must be boolean")
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


def _validate_email(value: Any, field: Field) -> str:
    value = _validate_text(value, field)
    if value and not _valid_email(value):
        raise ValueError(f"Field {field.id} must be an email address")
    return cast(str, value)


def _validate_url(value: Any, field: Field) -> str:
    value = _validate_text(value, field)
    if value and not _valid_url(value):
        raise ValueError(f"Field {field.id} must be an http or https URL")
    return cast(str, value)


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
    if not isinstance(value, str) or not valid_date(value):
        raise ValueError(f"Field {field.id} must be an ISO date")
    _validate_date_bounds(value, field, datetime_values=False)
    return value


def _validate_datetime(value: Any, field: Field) -> str:
    if not isinstance(value, str) or not valid_datetime(value):
        raise ValueError(f"Field {field.id} must be an ISO datetime")
    _validate_date_bounds(value, field, datetime_values=True)
    return value


def _validate_date_bounds(value: str, field: Field, *, datetime_values: bool) -> None:
    earliest = field.config.get("earliest")
    latest = field.config.get("latest")
    valid = valid_datetime if datetime_values else valid_date
    if any(
        bound is not None and (not isinstance(bound, str) or not valid(bound))
        for bound in (earliest, latest)
    ) or (
        earliest is not None
        and latest is not None
        and not date_in_range(earliest, None, latest, datetime_values=datetime_values)
    ):
        raise ValueError(f"Field {field.id} has invalid date configuration")
    if earliest is not None and not date_in_range(
        value, earliest, None, datetime_values=datetime_values
    ):
        raise ValueError(f"Field {field.id} is below its earliest value")
    if latest is not None and not date_in_range(
        value, None, latest, datetime_values=datetime_values
    ):
        raise ValueError(f"Field {field.id} exceeds its latest value")


def _validate_select(value: Any, field: Field) -> str:
    options = field.config.get("options")
    if (
        not isinstance(value, str)
        or not isinstance(options, list)
        or value not in {option.get("id") for option in options if isinstance(option, dict)}
    ):
        raise ValueError(f"Field {field.id} must be one of the configured options")
    return value


def _validate_user(value: Any, field: Field) -> str:
    if not isinstance(value, str):
        raise ValueError(f"Field {field.id} must be a user ID")
    try:
        if str(UUID(value)) != value:
            raise ValueError
    except ValueError as error:
        raise ValueError(f"Field {field.id} must be a user ID") from error
    return value


def _validate_relationship(value: Any, field: Field) -> Any:
    raise ValueError(f"Relationship field {field.id} is managed separately")


def _validate_numeric_bounds(value: int | float, field: Field) -> None:
    minimum = field.config.get("minimum")
    maximum = field.config.get("maximum")
    step = field.config.get("step")
    try:
        if minimum is not None and value < minimum:
            raise ValueError(f"Field {field.id} is below its minimum")
        if maximum is not None and value > maximum:
            raise ValueError(f"Field {field.id} exceeds its maximum")
        if step is not None:
            if not _finite_numeric(step) or step <= 0:
                raise TypeError
            if not numeric_matches_step(value, minimum or 0, step):
                raise ValueError(f"Field {field.id} does not match its step")
    except TypeError as error:
        raise ValueError(f"Field {field.id} has invalid numeric configuration") from error


FIELD_VALIDATORS: dict[FieldType, FieldValidator] = {
    FieldType.TEXT: _validate_text,
    FieldType.LONG_TEXT: _validate_text,
    FieldType.EMAIL: _validate_email,
    FieldType.URL: _validate_url,
    FieldType.NUMBER: _validate_number,
    FieldType.DECIMAL: _validate_decimal,
    FieldType.INTEGER: _validate_integer,
    FieldType.BOOLEAN: _validate_boolean,
    FieldType.DATE: _validate_date,
    FieldType.DATETIME: _validate_datetime,
    FieldType.SELECT: _validate_select,
    FieldType.USER: _validate_user,
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
