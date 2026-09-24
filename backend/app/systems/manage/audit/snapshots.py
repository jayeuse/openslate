from collections.abc import Collection, Mapping
from datetime import date, datetime, time
from enum import Enum
from typing import Any
from uuid import UUID

from sqlalchemy import inspect

AUDIT_METADATA_FIELDS = frozenset(
    {
        "id",
        "created_at",
        "updated_at",
        "performed_by",
        "invitation_sent_at",
        "invitation_accepted_at",
        "tokens_valid_after",
    }
)
REDACTED = "[REDACTED]"
SENSITIVE_FIELD_MARKERS = (
    "password",
    "token",
    "secret",
    "api_key",
    "credential",
    "private_key",
)


def is_sensitive_field(field_name: str, redacted_fields: Collection[str] = ()) -> bool:
    normalized = field_name.lower().replace("-", "_")
    configured_fields = {field.lower().replace("-", "_") for field in redacted_fields}
    return normalized in configured_fields or any(
        marker in normalized for marker in SENSITIVE_FIELD_MARKERS
    )


def serialize_value(
    value: Any,
    field_name: str | None = None,
    redacted_fields: Collection[str] = (),
) -> Any:
    if field_name and is_sensitive_field(field_name, redacted_fields):
        return REDACTED
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Mapping):
        return {
            str(key): serialize_value(item, str(key), redacted_fields)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [serialize_value(item, field_name, redacted_fields) for item in value]
    if isinstance(value, (bytes, bytearray, memoryview)):
        return REDACTED
    return REDACTED


def serialize_record(
    instance: Any,
    *,
    include_default_deletion_state: bool = False,
    redacted_fields: Collection[str] = (),
) -> dict[str, Any]:
    values: dict[str, Any] = {}
    model_redacted_fields: Collection[str] = getattr(
        type(instance),
        "__audit_redacted_fields__",
        frozenset(),
    )
    effective_redacted_fields = frozenset((*model_redacted_fields, *redacted_fields))
    for column in inspect(instance).mapper.column_attrs:
        field_name = column.key
        if field_name in AUDIT_METADATA_FIELDS:
            continue
        value = getattr(instance, field_name)
        if (
            not include_default_deletion_state
            and field_name == "is_deleted"
            and value is not True
        ):
            continue
        if not include_default_deletion_state and field_name == "deleted_at" and value is None:
            continue
        values[field_name] = serialize_value(value, field_name, effective_redacted_fields)
    return values


def _values_equal(left: Any, right: Any) -> bool:
    try:
        return bool(left == right)
    except (TypeError, ValueError):
        return left is right


def _mapping_diff(
    before: Mapping[str, Any],
    after: Mapping[str, Any],
    redacted_fields: Collection[str] = (),
) -> tuple[dict[str, Any], dict[str, Any]]:
    before_delta: dict[str, Any] = {}
    after_delta: dict[str, Any] = {}
    for key in before.keys() | after.keys():
        key_name = str(key)
        in_before = key in before
        in_after = key in after
        if in_before and in_after:
            old_value = before[key]
            new_value = after[key]
            if _values_equal(old_value, new_value):
                continue
            if isinstance(old_value, Mapping) and isinstance(new_value, Mapping):
                nested_before, nested_after = _mapping_diff(
                    old_value,
                    new_value,
                    redacted_fields,
                )
                if nested_before:
                    before_delta[key_name] = nested_before
                if nested_after:
                    after_delta[key_name] = nested_after
            else:
                before_delta[key_name] = serialize_value(old_value, key_name, redacted_fields)
                after_delta[key_name] = serialize_value(new_value, key_name, redacted_fields)
        elif in_before:
            before_delta[key_name] = serialize_value(before[key], key_name, redacted_fields)
        else:
            after_delta[key_name] = serialize_value(after[key], key_name, redacted_fields)
    return before_delta, after_delta


def _changed_value(
    field_name: str,
    before: Any,
    after: Any,
    redacted_fields: Collection[str] = (),
) -> tuple[Any, Any]:
    if (
        isinstance(before, Mapping)
        and isinstance(after, Mapping)
        and not is_sensitive_field(field_name, redacted_fields)
    ):
        before_delta, after_delta = _mapping_diff(before, after, redacted_fields)
        return (
            serialize_value(before_delta, field_name, redacted_fields),
            serialize_value(after_delta, field_name, redacted_fields),
        )
    return (
        serialize_value(before, field_name, redacted_fields),
        serialize_value(after, field_name, redacted_fields),
    )


def build_update_snapshot(
    changes: Mapping[str, tuple[Any, Any]],
    redacted_fields: Collection[str] = (),
) -> dict[str, dict[str, Any]]:
    before_snapshot: dict[str, Any] = {}
    after_snapshot: dict[str, Any] = {}
    for field_name, (before, after) in changes.items():
        if _values_equal(before, after):
            continue
        before_value, after_value = _changed_value(
            field_name,
            before,
            after,
            redacted_fields,
        )
        before_snapshot[field_name] = before_value
        after_snapshot[field_name] = after_value
    return {"before": before_snapshot, "after": after_snapshot}
