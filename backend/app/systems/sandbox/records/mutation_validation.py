"""Validation of submitted record values against the module's published fields."""

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from app.systems.access.policy.scope import module_reader_ids
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.fields.validation import parse_field_key, validate_field_value


@dataclass(frozen=True)
class RecordValidationIssue:
    code: str
    field_id: UUID | None
    message: str
    closed_field_mutation: bool = False


class RecordValidationError(ValueError):
    def __init__(
        self,
        issues: list[RecordValidationIssue],
        truncated: bool,
        has_closed_field_mutation: bool = False,
    ) -> None:
        super().__init__("Record data is invalid")
        self.issues = tuple(issues)
        self.truncated = truncated
        self._has_closed_field_mutation = has_closed_field_mutation

    @property
    def has_closed_field_mutation(self) -> bool:
        return self._has_closed_field_mutation or any(
            issue.closed_field_mutation for issue in self.issues
        )


def _apply_creation_defaults(data: dict[str, Any], fields: list[Field]) -> dict[str, Any]:
    """Apply published defaults to omitted primitive values only."""
    with_defaults = dict(data)
    for field in fields:
        key = str(field.id)
        if (
            key in with_defaults
            or field.is_deleted
            or FieldType(field.type) is FieldType.RELATIONSHIP
        ):
            continue
        if "defaultValue" in field.config:
            with_defaults[key] = field.config["defaultValue"]
    return with_defaults


def prepare_record_creation(
    db: Session,
    module_id: UUID,
    data: dict[str, Any],
    fields: list[Field],
    *,
    readers: frozenset[UUID] | None = None,
) -> dict[str, Any]:
    """Apply published defaults and validate one new record without writing it."""

    normalized = validate_record_mutation(_apply_creation_defaults(data, fields), {}, fields)
    validate_live_user_assignments(db, module_id, normalized, fields, readers=readers)
    return normalized


def validate_record_mutation(
    new_data: dict[str, Any],
    current_data: dict[str, Any],
    fields: list[Field],
) -> dict[str, Any]:
    """Validate a create or active-value replacement and return normalized data."""

    fields_by_id = {str(field.id): field for field in fields}
    closed_keys = {str(field.id) for field in fields if field.is_deleted}
    issues: list[RecordValidationIssue] = []
    truncated = False
    has_closed_field_mutation = False

    def add_issue(
        code: str,
        field_id: UUID | None,
        message: str,
        *,
        closed_field_mutation: bool = False,
    ) -> None:
        nonlocal truncated, has_closed_field_mutation
        if closed_field_mutation:
            has_closed_field_mutation = True
        if len(issues) < 20:
            issues.append(
                RecordValidationIssue(
                    code=code,
                    field_id=field_id,
                    message=message,
                    closed_field_mutation=closed_field_mutation,
                )
            )
        else:
            truncated = True

    normalized_active: dict[str, Any] = {}
    submitted_active_keys: set[str] = set()
    submitted_items = sorted(new_data.items(), key=lambda item: str(item[0]))

    # Phase 1: closed values are retained verbatim; only changed or new values
    # are conflicts. Relationship values are never accepted, but a changed
    # closed relationship is represented by one closed mutation issue.
    for key, raw_value in submitted_items:
        field = fields_by_id.get(key)
        if field is None or not field.is_deleted:
            continue

        field_type = FieldType(field.type)
        if field_type is FieldType.RELATIONSHIP:
            closed_value_changed = (
                key not in current_data
                or type(current_data[key]) is not type(raw_value)
                or current_data[key] != raw_value
            )
            if closed_value_changed:
                add_issue(
                    "closed_field_mutation",
                    field.id,
                    "Closed field values cannot be changed",
                    closed_field_mutation=True,
                )
            else:
                add_issue(
                    "relationship_field",
                    field.id,
                    "Relationship fields are managed separately",
                )
            continue
        if (
            key not in current_data
            or type(current_data[key]) is not type(raw_value)
            or current_data[key] != raw_value
        ):
            add_issue(
                "closed_field_mutation",
                field.id,
                "Closed field values cannot be changed",
                closed_field_mutation=True,
            )

    # Phase 2: known active values are validated and normalized. Relationship
    # values are rejected before the type registry is consulted.
    for key, raw_value in submitted_items:
        field = fields_by_id.get(key)
        if field is None or field.is_deleted:
            continue

        submitted_active_keys.add(key)
        field_type = FieldType(field.type)
        if field_type is FieldType.RELATIONSHIP:
            add_issue(
                "relationship_field",
                field.id,
                "Relationship fields are managed separately",
            )
            continue

        try:
            normalized_active[key] = validate_field_value(field, raw_value)
        except ValueError as error:
            code = (
                "required_field"
                if field.required and (raw_value is None or raw_value == "")
                else "invalid_field_value"
            )
            message = "Field is required" if code == "required_field" else str(error)
            add_issue(code, field.id, message)

    # Phase 3: malformed and unknown keys are reported after known values.
    for key, _raw_value in submitted_items:
        if key in fields_by_id:
            continue
        try:
            parsed_key = parse_field_key(key)
        except ValueError:
            add_issue("invalid_field_key", None, "Field key is invalid")
        else:
            add_issue("unknown_field", parsed_key, "Unknown or inactive field")

    # Phase 4: active required fields must be submitted for every replacement.
    for field in sorted(fields, key=lambda candidate: (candidate.position, str(candidate.id))):
        field_type = FieldType(field.type)
        key = str(field.id)
        if not field.is_deleted and field_type is not FieldType.RELATIONSHIP:
            if field.required and key not in submitted_active_keys:
                add_issue("required_field", field.id, "Field is required")

    if issues or has_closed_field_mutation:
        raise RecordValidationError(issues, truncated, has_closed_field_mutation)

    merged = {key: value for key, value in current_data.items() if key in closed_keys}
    merged.update(normalized_active)
    return merged


def validate_live_user_assignments(
    db: Session,
    module_id: UUID,
    data: dict[str, Any],
    fields: list[Field],
    *,
    readers: frozenset[UUID] | None = None,
) -> None:
    """Check only explicitly assigned active user values against current access.

    ``readers`` are the module's readers when the caller already read them in this
    transaction; otherwise they are read here.
    """

    assignments = [
        (field, data[str(field.id)])
        for field in fields
        if not field.is_deleted
        and FieldType(field.type) is FieldType.USER
        and str(field.id) in data
        and data[str(field.id)] is not None
    ]
    if not assignments:
        return
    if readers is None:
        readers = module_reader_ids(db, module_id)

    def eligible(value: Any) -> bool:
        if not isinstance(value, str):
            return False
        try:
            return UUID(value) in readers
        except ValueError:
            return False

    issues = [
        RecordValidationIssue(
            code="invalid_field_value",
            field_id=field.id,
            message="User must be an active reader of this module",
        )
        for field, value in assignments
        if not eligible(value)
    ]
    if issues:
        raise RecordValidationError(issues[:20], len(issues) > 20)
