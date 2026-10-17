import json
from datetime import UTC, datetime
from secrets import token_urlsafe
from typing import Any
from unittest.mock import Mock
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.fields.validation import (
    field_config,
    parse_field_key,
    validate_field_value,
    validate_record_data,
)
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.mutation_validation import (
    RecordValidationError,
    prepare_record_creation,
    validate_live_user_assignments,
    validate_record_mutation,
)
from app.systems.sandbox.records.router import update_record
from app.systems.sandbox.records.schemas import RecordUpdate
from tests.catalog.field_record_support import (
    OUTSIDER_ID,
    READER_ID,
    make_field,
    make_module,
)
from tests.catalog.field_record_support import module_readers as module_readers
from tests.rbac.support import make_user
from tests.repository import REPOSITORY_ROOT

REJECTED_VALUE_CANARY = token_urlsafe(32)


def _load_record_field_validation_cases() -> list[dict[str, Any]]:
    fixture_path = (
        REPOSITORY_ROOT / "contracts" / ("record-field-validation-cases.json")
    )
    with fixture_path.open(encoding="utf-8") as fixture:
        return json.load(fixture)["cases"]


RECORD_FIELD_VALIDATION_CASES = _load_record_field_validation_cases()


@pytest.mark.parametrize(
    ("field_type", "config"),
    [
        (FieldType.TEXT, {}),
        (FieldType.NUMBER, {}),
        (FieldType.DECIMAL, {}),
        (FieldType.INTEGER, {}),
        (FieldType.BOOLEAN, {}),
        (FieldType.DATE, {}),
        (FieldType.DATETIME, {}),
        (FieldType.SELECT, {"options": [{"id": str(uuid7()), "label": "open"}]}),
    ],
)
def test_optional_primitive_record_values_accept_null(
    field_type: FieldType, config: dict[str, object]
) -> None:
    field = make_field(uuid7(), field_type, config=config)

    assert validate_record_mutation({str(field.id): None}, {}, [field]) == {str(field.id): None}


@pytest.mark.parametrize("value", [None, ""])
def test_required_text_record_values_reject_null_and_empty(value: object) -> None:
    field = make_field(uuid7(), required=True)

    with pytest.raises(RecordValidationError) as raised:
        validate_record_mutation({str(field.id): value}, {}, [field])

    assert [issue.code for issue in raised.value.issues] == ["required_field"]
    with pytest.raises(ValueError, match=f"^Field {field.id} is required$"):
        validate_field_value(field, value)


def test_field_config_validates_text_and_canonicalizes_decimal_bounds() -> None:
    assert field_config(FieldType.TEXT, {"minLength": 1, "maxLength": 4}) == {
        "minLength": 1,
        "maxLength": 4,
    }
    with pytest.raises(ValueError, match="Text field minLength must be a nonnegative integer"):
        field_config(FieldType.TEXT, {"minLength": True})
    with pytest.raises(ValueError, match="Text field minLength cannot exceed maxLength"):
        field_config(FieldType.TEXT, {"minLength": 5, "maxLength": 4})

    assert field_config(
        FieldType.DECIMAL,
        {"minimum": "-0.1000", "maximum": "12.3400"},
    ) == {"minimum": "-0.1", "maximum": "12.34"}
    maximum_decimal = f"{'9' * 38}.{'9' * 18}"
    minimum_decimal = f"-{'9' * 38}.{'9' * 18}"
    assert field_config(
        FieldType.DECIMAL,
        {"minimum": minimum_decimal, "maximum": maximum_decimal},
    ) == {"minimum": minimum_decimal, "maximum": maximum_decimal}
    assert field_config(FieldType.DECIMAL, {"minimum": None}) == {"minimum": None}
    assert field_config(FieldType.DECIMAL, {"maximum": None}) == {"maximum": None}
    assert field_config(FieldType.DECIMAL, {"minimum": None, "maximum": None}) == {
        "minimum": None,
        "maximum": None,
    }
    assert (
        validate_field_value(
            make_field(
                uuid7(),
                FieldType.DECIMAL,
                config={"minimum": None, "maximum": None},
            ),
            "999.9900",
        )
        == "999.99"
    )
    with pytest.raises(ValueError, match="Decimal maximum has too many integer digits"):
        field_config(FieldType.DECIMAL, {"maximum": "1" * 39})
    with pytest.raises(ValueError, match="Decimal maximum has too many fractional digits"):
        field_config(FieldType.DECIMAL, {"maximum": "1." + "1" * 19})
    assert field_config(FieldType.DECIMAL, {"minimum": "0.00"}) == {"minimum": "0"}
    with pytest.raises(ValueError, match="Decimal minimum must be a valid decimal string"):
        field_config(FieldType.DECIMAL, {"minimum": 1.0})
    numeric_bound = 10**500
    assert field_config(FieldType.INTEGER, {"minimum": numeric_bound}) == {"minimum": numeric_bound}
    assert (
        validate_field_value(
            make_field(uuid7(), FieldType.INTEGER, config={"minimum": numeric_bound}),
            numeric_bound,
        )
        == numeric_bound
    )

    text_field = make_field(
        uuid7(),
        FieldType.TEXT,
        config={"minLength": 2, "maxLength": 4},
    )
    with pytest.raises(
        ValueError, match=f"Field {text_field.id} is shorter than its minimum length"
    ):
        validate_field_value(text_field, "x")
    with pytest.raises(ValueError, match=f"Field {text_field.id} exceeds its maximum length"):
        validate_field_value(text_field, "12345")


@pytest.mark.parametrize(
    ("field_type", "config"),
    [
        (FieldType.TEXT, {"minLength": 2, "defaultValue": "x"}),
        (FieldType.LONG_TEXT, {"maxLength": 3, "defaultValue": "long"}),
        (FieldType.EMAIL, {"defaultValue": "not-an-email"}),
        (FieldType.URL, {"defaultValue": "ftp://example.test"}),
    ],
)
def test_text_like_defaults_must_satisfy_their_field_constraints(
    field_type: FieldType, config: dict[str, object]
) -> None:
    with pytest.raises(ValueError, match="defaultValue"):
        field_config(field_type, config)


def test_numeric_defaults_are_normalized_and_enforce_bounds_and_steps() -> None:
    assert field_config(
        FieldType.INTEGER,
        {"minimum": 0.0, "maximum": 10.0, "step": 2.0, "defaultValue": 4.0},
    ) == {"minimum": 0, "maximum": 10, "step": 2, "defaultValue": 4}
    with pytest.raises(ValueError, match="below its minimum"):
        field_config(FieldType.NUMBER, {"minimum": 2, "defaultValue": 1})
    with pytest.raises(ValueError, match="exceeds its maximum"):
        field_config(FieldType.NUMBER, {"maximum": 2, "defaultValue": 3})
    with pytest.raises(ValueError, match="does not match field step"):
        field_config(FieldType.NUMBER, {"minimum": 0, "step": 2, "defaultValue": 3})

    stepped = make_field(
        uuid7(),
        FieldType.INTEGER,
        config={"minimum": 0, "maximum": 10**501, "step": 2},
    )
    assert validate_field_value(stepped, 10**500) == 10**500
    with pytest.raises(ValueError, match="does not match its step"):
        validate_field_value(stepped, 10**500 + 1)


def test_operational_date_and_datetime_constraints_match_designer_values() -> None:
    date_config = {
        "earliest": "2026-01-01",
        "latest": "2026-12-31",
        "defaultValue": "2026-06-01",
    }
    assert field_config(FieldType.DATE, date_config) == date_config
    date_field = make_field(uuid7(), FieldType.DATE, config=date_config)
    assert validate_field_value(date_field, "2026-12-31") == "2026-12-31"
    with pytest.raises(ValueError, match="below its earliest"):
        validate_field_value(date_field, "2025-12-31")
    with pytest.raises(ValueError, match="exceeds its latest"):
        validate_field_value(date_field, "2027-01-01")

    datetime_config = {
        "earliest": "2026-01-01T00:00Z",
        "latest": "2026-01-01T01:00Z",
        "defaultValue": "2026-01-01T00:30",
    }
    assert field_config(FieldType.DATETIME, datetime_config) == datetime_config
    datetime_field = make_field(uuid7(), FieldType.DATETIME, config=datetime_config)
    assert validate_field_value(datetime_field, "2025-12-31T19:30:00-05:00") == (
        "2025-12-31T19:30:00-05:00"
    )
    with pytest.raises(ValueError, match="below its earliest"):
        validate_field_value(datetime_field, "2025-12-31T18:59:00-05:00")
    with pytest.raises(ValueError, match="defaultValue"):
        field_config(
            FieldType.DATETIME,
            {
                "earliest": "2026-01-01T00:00Z",
                "latest": "2026-01-01T01:00Z",
                "defaultValue": "2025-12-31T18:59:00-05:00",
            },
        )


def test_decimal_validation_enforces_lexical_limits_and_exact_bounds() -> None:
    module_id = uuid7()
    field = make_field(
        module_id,
        FieldType.DECIMAL,
        config={"minimum": "-1.5", "maximum": "1.5"},
    )
    assert validate_field_value(field, "-0.5000") == "-0.5"
    assert validate_field_value(field, "-1.5000") == "-1.5"
    assert validate_field_value(field, "1.5000") == "1.5"
    assert validate_field_value(make_field(module_id, FieldType.DECIMAL), "-0.000") == "0"

    maximum_precision_value = "9" * 38 + "." + "123456789012345678"
    assert (
        validate_field_value(make_field(module_id, FieldType.DECIMAL), maximum_precision_value)
        == maximum_precision_value
    )
    not_decimal = "Decimal value must be a valid decimal string"
    too_precise = "Decimal value has too many fractional digits"
    with pytest.raises(ValueError, match=not_decimal):
        validate_field_value(field, "1e0")
    with pytest.raises(ValueError, match=not_decimal):
        validate_field_value(field, " 1")
    with pytest.raises(ValueError, match=too_precise):
        validate_field_value(field, "1.5000000000000000001")
    with pytest.raises(ValueError, match=f"Field {field.id} exceeds its maximum$"):
        validate_field_value(field, "2")
    with pytest.raises(ValueError, match=too_precise):
        validate_field_value(field, "-0.0000000000000000001")
    with pytest.raises(ValueError, match="Decimal value has too many integer digits"):
        validate_field_value(field, "1" * 39)
    with pytest.raises(ValueError, match=too_precise):
        validate_field_value(field, "1." + "1" * 19)
    with pytest.raises(ValueError, match=not_decimal):
        validate_field_value(field, "+1")
    with pytest.raises(ValueError, match=not_decimal):
        validate_field_value(field, "01")


@pytest.mark.parametrize(
    ("field_type", "config", "value", "message"),
    [
        (FieldType.NUMBER, {"minimum": 2}, 1, "below its minimum"),
        (FieldType.NUMBER, {"maximum": 0}, 1, "exceeds its maximum"),
        (FieldType.NUMBER, {"minimum": "zero"}, 1, "invalid numeric configuration"),
        (FieldType.DECIMAL, {"minimum": "2"}, "1", "below its minimum"),
        (FieldType.DECIMAL, {"minimum": 0}, "1", "invalid decimal configuration"),
        (FieldType.SELECT, {}, "open", "configured options"),
        (FieldType.NUMBER, {"step": 0}, 1, "invalid numeric configuration"),
        (FieldType.NUMBER, {"step": -1}, 1, "invalid numeric configuration"),
        (FieldType.TEXT, {"minLength": True}, "ab", "invalid text configuration"),
        (FieldType.TEXT, {"maxLength": True}, "ab", "invalid text configuration"),
        (FieldType.DATE, {"earliest": "bad"}, "2026-01-15", "invalid date configuration"),
        (
            FieldType.DATE,
            {"earliest": "2026-02-01", "latest": "2026-01-01"},
            "2026-01-15",
            "invalid date configuration",
        ),
    ],
)
def test_record_validation_rejects_malformed_persisted_field_configuration(
    field_type: FieldType, config: dict[str, object], value: object, message: str
) -> None:
    field = make_field(uuid7(), field_type, config=config)

    with pytest.raises(ValueError, match=message):
        validate_field_value(field, value)


def test_record_data_validation_rejects_unknown_relationship_and_missing_required_values() -> None:
    module_id = uuid7()
    required = make_field(module_id, required=True)
    relationship = make_field(module_id, FieldType.RELATIONSHIP)
    relationship.relationship_target_module_id = uuid7()
    relationship.relationship_multiple_targets = False
    relationship.relationship_multiple_sources = False

    with pytest.raises(ValueError, match="Unknown or inactive field"):
        validate_record_data({str(uuid7()): "extra"}, [required, relationship])
    with pytest.raises(ValueError, match="managed separately"):
        validate_record_data(
            {str(required.id): "present", str(relationship.id): "unexpected"},
            [required, relationship],
        )
    with pytest.raises(ValueError, match="is required"):
        validate_record_data({}, [required, relationship])
    validate_record_data({str(required.id): "present"}, [required, relationship])
    with pytest.raises(ValueError, match=f"^Field {required.id} is required$"):
        validate_record_data({}, [relationship, required])
    optional = make_field(module_id, FieldType.INTEGER)
    validate_record_data({str(required.id): "present"}, [relationship, required, optional])
    with pytest.raises(ValueError, match=f"^Field {optional.id} must be an integer$"):
        validate_record_data(
            {str(required.id): "present", str(optional.id): "1"},
            [relationship, required, optional],
        )
    with pytest.raises(ValueError, match="^Invalid field key: not-a-field-id$"):
        parse_field_key("not-a-field-id")


def test_record_mutation_aggregates_errors_and_normalizes_active_values() -> None:
    module_id = uuid7()
    required = make_field(module_id, required=True)
    decimal = make_field(module_id, FieldType.DECIMAL, config={"maximum": "2"})
    decimal.position = 1
    closed = make_field(module_id, deleted=True)
    closed.position = 2
    current = {str(required.id): "old", str(closed.id): "legacy"}
    requested = {
        str(required.id): "new",
        str(decimal.id): "1.2300",
        str(closed.id): "changed",
        "not-a-field-id": "do not echo",
    }

    with pytest.raises(RecordValidationError) as raised:
        validate_record_mutation(requested, current, [required, decimal, closed])

    error = raised.value
    assert [issue.code for issue in error.issues] == [
        "closed_field_mutation",
        "invalid_field_key",
    ]
    assert all("do not echo" not in issue.message for issue in error.issues)
    assert all("not-a-field-id" not in issue.message for issue in error.issues)

    assert validate_record_mutation(
        {str(required.id): "new", str(decimal.id): "1.2300"},
        current,
        [required, decimal, closed],
    ) == {str(required.id): "new", str(decimal.id): "1.23", str(closed.id): "legacy"}


def test_record_mutation_caps_deterministic_errors() -> None:
    errors = {str(uuid7()): index for index in range(21)}

    with pytest.raises(RecordValidationError) as first:
        validate_record_mutation(errors, {}, [])
    reversed_errors = dict(reversed(list(errors.items())))
    with pytest.raises(RecordValidationError) as raised:
        validate_record_mutation(reversed_errors, {}, [])

    assert len(raised.value.issues) == 20
    assert raised.value.truncated is True
    assert all(issue.code == "unknown_field" for issue in raised.value.issues)
    assert [str(issue.field_id) for issue in first.value.issues] == [
        str(issue.field_id) for issue in raised.value.issues
    ]


def _issues(error: RecordValidationError) -> list[tuple[str, UUID | None, str]]:
    return [(issue.code, issue.field_id, issue.message) for issue in error.issues]


def _relationship(module_id: UUID, *, required: bool = False, deleted: bool = False) -> Field:
    field = make_field(module_id, FieldType.RELATIONSHIP, required=required, deleted=deleted)
    field.relationship_target_module_id = uuid7()
    field.relationship_multiple_targets = False
    field.relationship_multiple_sources = False
    return field


def test_record_mutation_reports_each_issue_with_its_field_and_message() -> None:
    # Field IDs are UUIDv7, so creation order is the sorted key order the phases walk.
    module_id = uuid7()
    closed_link_kept = _relationship(module_id, deleted=True)
    closed_link_added = _relationship(module_id, deleted=True)
    closed_link_retyped = _relationship(module_id, deleted=True)
    closed_link_changed = _relationship(module_id, deleted=True)
    closed_text = make_field(module_id, deleted=True)
    closed_required = make_field(module_id, required=True, deleted=True)
    active_link = _relationship(module_id)
    required_link = _relationship(module_id, required=True)
    optional_integer = make_field(module_id, FieldType.INTEGER)
    required_text = make_field(module_id, required=True)
    required_omitted = make_field(module_id, required=True)
    for position, field in enumerate([active_link, required_link, optional_integer, required_text]):
        field.position = position
    required_omitted.position = 4
    unknown_key = str(uuid7())
    fields = [
        required_omitted,
        required_text,
        optional_integer,
        required_link,
        active_link,
        closed_required,
        closed_text,
        closed_link_changed,
        closed_link_retyped,
        closed_link_added,
        closed_link_kept,
    ]
    current = {
        str(closed_link_kept.id): "kept",
        str(closed_link_retyped.id): 1,
        str(closed_link_changed.id): "before",
        str(closed_text.id): "legacy",
    }
    requested = {
        "not-a-field-id": "do not echo",
        unknown_key: "extra",
        str(required_text.id): None,
        str(optional_integer.id): "",
        str(active_link.id): "linked",
        str(closed_text.id): "changed",
        str(closed_link_changed.id): "after",
        str(closed_link_retyped.id): True,
        str(closed_link_added.id): "added",
        str(closed_link_kept.id): "kept",
    }

    with pytest.raises(RecordValidationError) as raised:
        validate_record_mutation(requested, current, fields)

    closed = "Closed field values cannot be changed"
    separate = "Relationship fields are managed separately"
    assert _issues(raised.value) == [
        ("relationship_field", closed_link_kept.id, separate),
        ("closed_field_mutation", closed_link_added.id, closed),
        ("closed_field_mutation", closed_link_retyped.id, closed),
        ("closed_field_mutation", closed_link_changed.id, closed),
        ("closed_field_mutation", closed_text.id, closed),
        ("relationship_field", active_link.id, separate),
        (
            "invalid_field_value",
            optional_integer.id,
            f"Field {optional_integer.id} must be an integer",
        ),
        ("required_field", required_text.id, "Field is required"),
        ("unknown_field", UUID(unknown_key), "Unknown or inactive field"),
        ("invalid_field_key", None, "Field key is invalid"),
        ("required_field", required_omitted.id, "Field is required"),
    ]
    assert raised.value.truncated is False
    assert raised.value.has_closed_field_mutation is True


@pytest.mark.parametrize(
    ("submitted", "code", "message", "conflict"),
    [
        ("kept", "relationship_field", "Relationship fields are managed separately", False),
        ("changed", "closed_field_mutation", "Closed field values cannot be changed", True),
    ],
)
def test_a_closed_relationship_value_conflicts_only_when_it_changes(
    submitted: str, code: str, message: str, conflict: bool
) -> None:
    module_id = uuid7()
    closed_link = _relationship(module_id, deleted=True)
    text = make_field(module_id)

    with pytest.raises(RecordValidationError) as raised:
        validate_record_mutation(
            {str(closed_link.id): submitted, str(text.id): "value"},
            {str(closed_link.id): "kept"},
            [closed_link, text],
        )

    assert _issues(raised.value) == [(code, closed_link.id, message)]
    assert raised.value.truncated is False
    assert raised.value.has_closed_field_mutation is conflict


def test_a_closed_value_change_past_the_issue_cap_still_conflicts() -> None:
    module_id = uuid7()
    kept_links = [_relationship(module_id, deleted=True) for _ in range(20)]
    closed_text = make_field(module_id, deleted=True)
    current = {str(field.id): "kept" for field in kept_links} | {str(closed_text.id): "old"}

    with pytest.raises(RecordValidationError) as raised:
        validate_record_mutation(
            current | {str(closed_text.id): "new"}, current, [*kept_links, closed_text]
        )

    assert {issue.code for issue in raised.value.issues} == {"relationship_field"}
    assert len(raised.value.issues) == 20
    assert raised.value.truncated is True
    assert raised.value.has_closed_field_mutation is True


def test_record_mutation_orders_issues_by_key_whatever_the_values() -> None:
    first = "0190f2c4-0000-7000-8000-00000000000a"
    second = "0190f2c4-0000-7000-8000-00000000000b"
    third = "0190f2c4-0000-7000-8000-00000000000c"

    with pytest.raises(RecordValidationError) as raised:
        validate_record_mutation({third: "same", second: "same", first: "same"}, {}, [])

    assert [str(issue.field_id) for issue in raised.value.issues] == [first, second, third]


NOT_A_READER = "User must be an active reader of this module"


def test_only_explicit_active_user_values_must_be_module_readers(module_readers) -> None:
    db, module_id = module_readers
    reader = make_field(module_id, FieldType.USER)
    closed_user = make_field(module_id, FieldType.USER, deleted=True)
    text = make_field(module_id)
    omitted = make_field(module_id, FieldType.USER)
    cleared = make_field(module_id, FieldType.USER)
    number = make_field(module_id, FieldType.USER)
    malformed = make_field(module_id, FieldType.USER)
    outsider = make_field(module_id, FieldType.USER)
    data = {
        str(reader.id): READER_ID,
        str(closed_user.id): OUTSIDER_ID,
        str(text.id): OUTSIDER_ID,
        str(cleared.id): None,
        str(number.id): 5,
        str(malformed.id): "not-a-user",
        str(outsider.id): OUTSIDER_ID,
    }
    fields = [reader, closed_user, text, omitted, cleared, number, malformed, outsider]

    validate_live_user_assignments(db, module_id, {str(reader.id): READER_ID}, fields)
    with pytest.raises(RecordValidationError) as raised:
        validate_live_user_assignments(db, module_id, data, fields)

    assert _issues(raised.value) == [
        ("invalid_field_value", number.id, NOT_A_READER),
        ("invalid_field_value", malformed.id, NOT_A_READER),
        ("invalid_field_value", outsider.id, NOT_A_READER),
    ]
    assert raised.value.truncated is False
    assert raised.value.has_closed_field_mutation is False


@pytest.mark.parametrize(("assigned", "reported", "truncated"), [(20, 20, False), (21, 20, True)])
def test_user_value_issues_are_capped_at_twenty(
    module_readers, assigned: int, reported: int, truncated: bool
) -> None:
    db, module_id = module_readers
    fields = [make_field(module_id, FieldType.USER) for _ in range(assigned)]

    with pytest.raises(RecordValidationError) as raised:
        validate_live_user_assignments(
            db, module_id, {str(field.id): OUTSIDER_ID for field in fields}, fields
        )

    assert len(raised.value.issues) == reported
    assert raised.value.truncated is truncated


def test_record_creation_applies_published_defaults_to_omitted_primitive_values(
    module_readers,
) -> None:
    db, module_id = module_readers
    closed = make_field(module_id, deleted=True, config={"defaultValue": "closed default"})
    link = _relationship(module_id)
    link.config = {"defaultValue": "link default"}
    submitted = make_field(module_id, config={"defaultValue": "default"})
    applied = make_field(module_id, required=True, config={"defaultValue": "applied default"})
    no_default = make_field(module_id, FieldType.INTEGER)
    assignee = make_field(module_id, FieldType.USER)

    assert prepare_record_creation(
        db,
        module_id,
        {str(submitted.id): "mine", str(assignee.id): READER_ID},
        [closed, link, submitted, applied, no_default, assignee],
    ) == {
        str(submitted.id): "mine",
        str(applied.id): "applied default",
        str(assignee.id): READER_ID,
    }


USER_ID = "0192f0c4-6b1e-7c3a-9d2e-4f5a6b7c8d9e"


@pytest.mark.parametrize(
    ("field_type", "config", "value"),
    [
        (FieldType.NUMBER, {"maximum": 1}, 1),
        (FieldType.NUMBER, {"step": 0.5}, 1.5),
        (FieldType.NUMBER, {"step": 2}, 4),
        (FieldType.TEXT, {"minLength": 2}, "ab"),
        (FieldType.EMAIL, {}, "ops@example.test"),
        (FieldType.EMAIL, {}, ""),
        (FieldType.URL, {}, "https://example.test/path"),
        (FieldType.URL, {}, ""),
        (FieldType.USER, {}, USER_ID),
    ],
)
def test_record_values_on_their_limits_are_accepted_unchanged(
    field_type: FieldType, config: dict[str, object], value: object
) -> None:
    field = make_field(uuid7(), field_type, config=config)

    assert validate_field_value(field, value) == value


@pytest.mark.parametrize(
    ("field_type", "value", "message"),
    [
        (FieldType.NUMBER, "1", "must be a number"),
        (FieldType.EMAIL, "not-an-email", "must be an email address"),
        (FieldType.URL, "ftp://example.test", "must be an http or https URL"),
        (FieldType.USER, 5, "must be a user ID"),
        (FieldType.USER, "not-a-user", "must be a user ID"),
        (FieldType.USER, USER_ID.upper(), "must be a user ID"),
    ],
)
def test_record_values_of_the_wrong_kind_are_refused(
    field_type: FieldType, value: object, message: str
) -> None:
    field = make_field(uuid7(), field_type)

    with pytest.raises(ValueError, match=f"^Field {field.id} {message}$"):
        validate_field_value(field, value)


# The message each field type raises for the shared fixture's "invalid" value.
INVALID_VALUE_MESSAGES = {
    FieldType.TEXT: "^Field {id} must be text$",
    FieldType.NUMBER: "^Field {id} must be a number$",
    FieldType.DECIMAL: "^Decimal value must be a valid decimal string$",
    FieldType.INTEGER: "^Field {id} must be an integer$",
    FieldType.BOOLEAN: "^Field {id} must be boolean$",
    FieldType.DATE: "^Field {id} must be an ISO date$",
    FieldType.DATETIME: "^Field {id} must be an ISO datetime$",
    FieldType.SELECT: "^Field {id} must be one of the configured options$",
    FieldType.RELATIONSHIP: "^Relationship field {id} is managed separately$",
}


@pytest.mark.parametrize(
    "case",
    RECORD_FIELD_VALIDATION_CASES,
    ids=lambda case: case["type"],
)
def test_shared_record_field_validation_cases(case: dict[str, Any]) -> None:
    field_type = FieldType(case["type"])
    field = make_field(uuid7(), field_type, config=case["config"])
    if field_type is FieldType.RELATIONSHIP:
        field.relationship_target_module_id = uuid7()
        field.relationship_multiple_targets = False
        field.relationship_multiple_sources = False

    if case["validAccepted"] is True:
        assert validate_field_value(field, case["valid"]) == case["normalized"]
    else:
        with pytest.raises(
            ValueError, match=f"Relationship field {field.id} is managed separately"
        ):
            validate_field_value(field, case["valid"])

    with pytest.raises(ValueError, match=INVALID_VALUE_MESSAGES[field_type].format(id=field.id)):
        validate_field_value(field, case["invalid"])


def test_record_patch_rejects_type_changed_closed_integer_value() -> None:
    module = make_module()
    closed = make_field(module.id, FieldType.INTEGER, deleted=True)
    record = Record(module_id=module.id, data={str(closed.id): 1})
    record.id = uuid7()
    record.created_at = datetime.now(UTC)
    record.updated_at = record.created_at
    record.is_deleted = False
    db = Mock(spec=Session)
    db.info = {}  # a real Session.info is a dict; the lock helper keeps a marker in it
    db.get.side_effect = lambda model, *_args, **_kwargs: module if model is Module else record
    db.scalar.return_value = module
    db.scalars.return_value.all.return_value = [closed]
    actor, membership = make_user("record_writer")
    db.dirty = set()
    db.scalars.side_effect = lambda query: Mock(all=lambda: (
        [membership] if query.column_descriptions[0]["entity"] is type(membership) else [closed]
    ))

    update_record(
        record.id,
        RecordUpdate(data={str(closed.id): 1}),
        actor,
        db,
        if_match=record.updated_at.isoformat(),
    )
    assert record.data == {str(closed.id): 1}

    with pytest.raises(HTTPException) as raised:
        update_record(
            record.id,
            RecordUpdate(data={str(closed.id): True}),
            actor,
            db,
            if_match=record.updated_at.isoformat(),
        )

    assert raised.value.status_code == 409
    assert raised.value.detail["errors"][0]["code"] == "closed_field_mutation"
    assert record.data == {str(closed.id): 1}
