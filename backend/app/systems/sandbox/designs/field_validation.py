"""Portable field-value and relationship-mapping validation."""

import re
from dataclasses import dataclass
from math import isfinite
from urllib.parse import urlparse
from uuid import UUID

from app.systems.sandbox.designs.date_values import date_in_range, valid_date, valid_datetime
from app.systems.sandbox.numeric import numeric_matches_step

type Scalar = str | int | float | bool | None


class DocumentValueError(ValueError):
    """A portable design value or mapping is not safe to apply."""


@dataclass(frozen=True, slots=True)
class FieldMetadata:
    config_kind: str
    required: bool
    closed: bool
    select_options: frozenset[str]
    select_labels: frozenset[str]
    max_length: int | None
    minimum: float | None
    maximum: float | None
    step: float | None
    earliest: str | None
    latest: str | None


def validate_value(value: Scalar, field: FieldMetadata) -> None:
    """Reject a value the portable document would not admit for a field."""

    if field.closed:
        raise DocumentValueError("values cannot target closed fields")
    if value is None:
        if field.required:
            raise DocumentValueError("required field cannot use null")
        return
    if isinstance(value, str) and field.required and not value.strip():
        raise DocumentValueError("required field cannot use an empty string")
    if field.config_kind == "checkbox":
        valid = isinstance(value, bool)
    elif field.config_kind == "integer":
        valid = isinstance(value, int) and not isinstance(value, bool)
    elif field.config_kind == "number":
        valid = isinstance(value, (int, float)) and not isinstance(value, bool)
    elif field.config_kind == "select":
        valid = isinstance(value, str) and value in field.select_options
    elif field.config_kind == "user":
        if not isinstance(value, str):
            valid = False
        else:
            try:
                valid = str(UUID(value)) == value
            except ValueError:
                valid = False
    elif field.config_kind == "date":
        valid = isinstance(value, str) and valid_date(value) and _date_in_range(value, field)
    elif field.config_kind == "datetime":
        valid = isinstance(value, str) and valid_datetime(value) and _date_in_range(value, field)
    elif field.config_kind == "email":
        valid = isinstance(value, str) and (not value or _valid_email(value))
    elif field.config_kind == "url":
        valid = isinstance(value, str) and (not value or _valid_http_url(value))
    else:
        valid = isinstance(value, str)
    if not valid or (isinstance(value, float) and not isfinite(value)):
        raise DocumentValueError(f"value is incompatible with {field.config_kind} field")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        _validate_numeric_value(value, field)
    if isinstance(value, str) and field.max_length is not None and len(value) > field.max_length:
        raise DocumentValueError("value exceeds field maxLength")


def validate_mapping(source: FieldMetadata, target: FieldMetadata, relationship_id: str) -> None:
    """Reject closed or directionally incompatible mapping endpoints."""

    if source.closed or target.closed:
        raise DocumentValueError(f"relationship {relationship_id} maps a closed field")
    if not source.required and target.required:
        raise DocumentValueError(f"relationship {relationship_id} maps optional into required")
    if source.config_kind == "select":
        if target.config_kind == "select" and source.select_labels <= target.select_labels:
            return
        raise DocumentValueError(f"relationship {relationship_id} has incompatible field mappings")
    if source.config_kind in {"number", "integer"}:
        if target.config_kind not in {"number", source.config_kind} or not _numeric_fits(
            source, target
        ):
            raise DocumentValueError(
                f"relationship {relationship_id} has incompatible field mappings"
            )
        return
    if source.config_kind in {"date", "datetime"}:
        if target.config_kind == source.config_kind and _date_range_fits(
            source.earliest,
            source.latest,
            target.earliest,
            target.latest,
            datetime_values=source.config_kind == "datetime",
        ):
            return
        raise DocumentValueError(f"relationship {relationship_id} has incompatible field mappings")
    if source.config_kind == target.config_kind and source.config_kind == "checkbox":
        return
    if (
        source.config_kind == target.config_kind
        and source.config_kind in {"text", "long-text", "email", "url"}
        and _length_fits(source, target)
    ):
        return
    if (
        source.config_kind in {"text", "long-text", "email", "url"}
        and target.config_kind in {"text", "long-text"}
        and _length_fits(source, target)
    ):
        return
    raise DocumentValueError(f"relationship {relationship_id} has incompatible field mappings")


def _length_fits(source: FieldMetadata, target: FieldMetadata) -> bool:
    if target.max_length is None:
        return True
    return source.max_length is not None and source.max_length <= target.max_length


def _numeric_range_fits(
    source_minimum: float | None,
    source_maximum: float | None,
    target_minimum: float | None,
    target_maximum: float | None,
) -> bool:
    return (
        target_minimum is None or source_minimum is not None and source_minimum >= target_minimum
    ) and (
        target_maximum is None or source_maximum is not None and source_maximum <= target_maximum
    )


def _date_range_fits(
    source_minimum: str | None,
    source_maximum: str | None,
    target_minimum: str | None,
    target_maximum: str | None,
    *,
    datetime_values: bool,
) -> bool:
    return (
        target_minimum is None
        or source_minimum is not None
        and date_in_range(
            source_minimum, target_minimum, None, datetime_values=datetime_values
        )
    ) and (
        target_maximum is None
        or source_maximum is not None
        and date_in_range(
            source_maximum, None, target_maximum, datetime_values=datetime_values
        )
    )


def _numeric_fits(source: FieldMetadata, target: FieldMetadata) -> bool:
    if not _numeric_range_fits(
        source.minimum,
        source.maximum,
        target.minimum,
        target.maximum,
    ):
        return False
    if target.step is None:
        return True
    source_step = (
        source.step if source.step is not None else (1 if source.config_kind == "integer" else None)
    )
    if source_step is None or target.step <= 0:
        return False
    return numeric_matches_step(source_step, 0, target.step) and numeric_matches_step(
        (source.minimum or 0) - (target.minimum or 0), 0, target.step
    )


def _validate_numeric_value(value: int | float, field: FieldMetadata) -> None:
    if field.minimum is not None and value < field.minimum:
        raise DocumentValueError("value is below field minimum")
    if field.maximum is not None and value > field.maximum:
        raise DocumentValueError("value is above field maximum")
    step = field.step if field.step is not None else (1 if field.config_kind == "integer" else None)
    if step is not None:
        if step <= 0 or not numeric_matches_step(value, field.minimum or 0, step):
            raise DocumentValueError("value does not match field step")


def _date_in_range(value: str, field: FieldMetadata) -> bool:
    return date_in_range(
        value,
        field.earliest,
        field.latest,
        datetime_values=field.config_kind == "datetime",
    )


def _valid_email(value: str) -> bool:
    return re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value) is not None


def _valid_http_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)
