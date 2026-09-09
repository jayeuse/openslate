import json
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.fields.models import FieldType
from app.systems.fields.schemas import FieldCreate
from app.systems.fields.validation import (
    FIELD_VALIDATORS,
    field_config,
    validate_field_value,
)
from app.systems.modules.models import Module
from app.systems.records.models import Record
from app.systems.records.router import (
    RecordValidationError,
    create_record,
    update_record,
    validate_record_mutation,
)
from app.systems.records.schemas import RecordCreate, RecordUpdate
from tests.field_record_support import make_field, make_module


def _load_record_field_validation_cases() -> list[dict[str, Any]]:
    fixture_path = Path(__file__).resolve().parents[2] / "contracts" / (
        "record-field-validation-cases.json"
    )
    with fixture_path.open(encoding="utf-8") as fixture:
        return json.load(fixture)["cases"]


RECORD_FIELD_VALIDATION_CASES = _load_record_field_validation_cases()

def test_field_validators_cover_every_type_and_return_clean_values() -> None:
    module_id = uuid7()
    fields = {
        FieldType.TEXT: make_field(module_id),
        FieldType.NUMBER: make_field(module_id, FieldType.NUMBER),
        FieldType.DECIMAL: make_field(module_id, FieldType.DECIMAL),
        FieldType.INTEGER: make_field(module_id, FieldType.INTEGER),
        FieldType.BOOLEAN: make_field(module_id, FieldType.BOOLEAN),
        FieldType.DATE: make_field(module_id, FieldType.DATE),
        FieldType.DATETIME: make_field(module_id, FieldType.DATETIME),
        FieldType.SELECT: make_field(module_id, FieldType.SELECT, config={"options": ["open"]}),
        FieldType.RELATIONSHIP: make_field(module_id, FieldType.RELATIONSHIP),
    }
    relationship = fields[FieldType.RELATIONSHIP]
    relationship.relationship_target_module_id = uuid7()
    relationship.relationship_multiple_targets = False
    relationship.relationship_multiple_sources = False

    assert set(FIELD_VALIDATORS) == set(FieldType)
    assert validate_field_value(fields[FieldType.TEXT], "title") == "title"
    assert validate_field_value(fields[FieldType.NUMBER], 1.5) == 1.5
    assert validate_field_value(fields[FieldType.DECIMAL], "1.500") == "1.5"
    assert validate_field_value(fields[FieldType.INTEGER], 3) == 3
    assert validate_field_value(fields[FieldType.BOOLEAN], True) is True
    assert validate_field_value(fields[FieldType.DATE], "2026-08-19") == "2026-08-19"
    assert (
        validate_field_value(fields[FieldType.DATETIME], "2026-08-19T12:00:00Z")
        == "2026-08-19T12:00:00Z"
    )
    assert validate_field_value(fields[FieldType.SELECT], "open") == "open"
    invalid_values = {
        FieldType.TEXT: 1,
        FieldType.NUMBER: True,
        FieldType.DECIMAL: 1,
        FieldType.INTEGER: 1.5,
        FieldType.BOOLEAN: 1,
        FieldType.DATE: "19/08/2026",
        FieldType.DATETIME: "2026-08-19T12:00:00",
        FieldType.SELECT: "closed",
        FieldType.RELATIONSHIP: None,
    }
    for field_type, invalid_value in invalid_values.items():
        with pytest.raises(ValueError):
            validate_field_value(fields[field_type], invalid_value)


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
        (FieldType.SELECT, {"options": ["open"]}),
    ],
)
def test_optional_primitive_record_values_accept_null(
    field_type: FieldType, config: dict[str, object]
) -> None:
    field = make_field(uuid7(), field_type, config=config)

    assert validate_record_mutation({str(field.id): None}, {}, [field]) == {
        str(field.id): None
    }


@pytest.mark.parametrize("value", [None, ""])
def test_required_text_record_values_reject_null_and_empty(value: object) -> None:
    field = make_field(uuid7(), required=True)

    with pytest.raises(RecordValidationError) as raised:
        validate_record_mutation({str(field.id): value}, {}, [field])

    assert [issue.code for issue in raised.value.issues] == ["required_field"]


def test_text_validation_preserves_whitespace_and_counts_unicode_codepoints() -> None:
    field = make_field(
        uuid7(),
        required=True,
        config={"minLength": 2, "maxLength": 2},
    )

    assert validate_field_value(field, " \t") == " \t"
    assert validate_field_value(field, "e\u0301") == "e\u0301"
    with pytest.raises(ValueError):
        validate_field_value(field, "é")


def test_field_config_validates_text_and_canonicalizes_decimal_bounds() -> None:
    assert field_config(FieldType.TEXT, {"minLength": 1, "maxLength": 4}) == {
        "minLength": 1,
        "maxLength": 4,
    }
    with pytest.raises(ValueError):
        field_config(FieldType.TEXT, {"minLength": True})
    with pytest.raises(ValueError):
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
    assert validate_field_value(
        make_field(
            uuid7(),
            FieldType.DECIMAL,
            config={"minimum": None, "maximum": None},
        ),
        "999.9900",
    ) == "999.99"
    with pytest.raises(ValueError):
        field_config(FieldType.DECIMAL, {"maximum": "1" * 39})
    with pytest.raises(ValueError):
        field_config(FieldType.DECIMAL, {"maximum": "1." + "1" * 19})
    assert FieldCreate(
        module_id=uuid7(),
        name="Amount",
        type=FieldType.DECIMAL,
        position=0,
        config={"minimum": "0.00"},
    ).config == {"minimum": "0"}
    with pytest.raises(ValueError):
        field_config(FieldType.DECIMAL, {"minimum": 1.0})
    numeric_bound = 10**500
    assert field_config(FieldType.INTEGER, {"minimum": numeric_bound}) == {
        "minimum": numeric_bound
    }
    assert validate_field_value(
        make_field(uuid7(), FieldType.INTEGER, config={"minimum": numeric_bound}),
        numeric_bound,
    ) == numeric_bound

    text_field = make_field(
        uuid7(),
        FieldType.TEXT,
        config={"minLength": 2, "maxLength": 4},
    )
    with pytest.raises(ValueError):
        validate_field_value(text_field, "x")
    with pytest.raises(ValueError):
        validate_field_value(text_field, "12345")


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
        validate_field_value(
            make_field(module_id, FieldType.DECIMAL), maximum_precision_value
        )
        == maximum_precision_value
    )
    with pytest.raises(ValueError):
        validate_field_value(field, "1e0")
    with pytest.raises(ValueError):
        validate_field_value(field, " 1")
    with pytest.raises(ValueError):
        validate_field_value(field, "1.5000000000000000001")
    with pytest.raises(ValueError):
        validate_field_value(field, "2")
    with pytest.raises(ValueError):
        validate_field_value(field, "-0.0000000000000000001")
    with pytest.raises(ValueError):
        validate_field_value(field, "1" * 39)
    with pytest.raises(ValueError):
        validate_field_value(field, "1." + "1" * 19)
    with pytest.raises(ValueError):
        validate_field_value(field, "+1")
    with pytest.raises(ValueError):
        validate_field_value(field, "01")


def test_date_validation_accepts_calendar_boundaries_and_rejects_invalid_dates() -> None:
    field = make_field(uuid7(), FieldType.DATE)

    assert validate_field_value(field, "0001-01-01") == "0001-01-01"
    assert validate_field_value(field, "9999-12-31") == "9999-12-31"
    for value in ("0000-01-01", "9999-02-29", "2026-02-29", "2026-13-01"):
        with pytest.raises(ValueError):
            validate_field_value(field, value)


def test_datetime_validation_accepts_datetime_boundaries_and_rejects_invalid_dates() -> None:
    field = make_field(uuid7(), FieldType.DATETIME)

    assert validate_field_value(field, "0001-01-01T00:00:00Z") == "0001-01-01T00:00:00Z"
    assert (
        validate_field_value(field, "9999-12-31T23:59:59.999999+14:00")
        == "9999-12-31T23:59:59.999999+14:00"
    )
    for value in (
        "0000-01-01T00:00:00Z",
        "2026-02-29T00:00:00Z",
        "2026-01-01T00:00:00+24:00",
        "2026-01-01T00:00:00.1234567Z",
    ):
        with pytest.raises(ValueError):
            validate_field_value(field, value)


def test_datetime_validation_requires_strict_timezone_aware_profile() -> None:
    field = make_field(uuid7(), FieldType.DATETIME)
    for value in (
        "2026-08-19 12:00:00Z",
        "2026-08-19T12:00:00",
        "20260819T120000Z",
        "2026-08-19T12:00:00.1234567Z",
    ):
        with pytest.raises(ValueError):
            validate_field_value(field, value)


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


def test_record_mutation_reports_errors_in_deterministic_phases() -> None:
    module_id = uuid7()
    required = make_field(module_id, required=True)
    active = make_field(module_id, FieldType.INTEGER)
    relationship = make_field(module_id, FieldType.RELATIONSHIP)
    relationship.relationship_target_module_id = uuid7()
    relationship.relationship_multiple_targets = False
    relationship.relationship_multiple_sources = False
    closed = make_field(module_id, deleted=True)
    current = {str(closed.id): "legacy"}
    malformed_key = "not-a-field-id"
    unknown_key = str(uuid7())
    requested = {
        malformed_key: "secret",
        unknown_key: "secret",
        str(relationship.id): None,
        str(active.id): "not-an-integer",
        str(closed.id): "changed",
    }

    with pytest.raises(RecordValidationError) as raised:
        validate_record_mutation(requested, current, [closed, relationship, active, required])

    issues = list(raised.value.issues)
    assert issues[0].code == "closed_field_mutation"
    phase_two = sorted(
        [
            (str(active.id), "invalid_field_value"),
            (str(relationship.id), "relationship_field"),
        ]
    )
    assert [issue.code for issue in issues[1:3]] == [code for _, code in phase_two]
    phase_three = sorted(
        [
            (malformed_key, "invalid_field_key"),
            (unknown_key, "unknown_field"),
        ]
    )
    assert [issue.code for issue in issues[3:5]] == [code for _, code in phase_three]
    assert issues[5].code == "required_field"


@pytest.mark.parametrize(
    ("requested_value", "expected_code"),
    [("changed", "closed_field_mutation"), ("legacy", "relationship_field")],
)
def test_record_mutation_does_not_duplicate_relationship_and_closed_issues(
    requested_value: str, expected_code: str
) -> None:
    module = make_module()
    field = make_field(module.id, FieldType.RELATIONSHIP, deleted=True)
    field.relationship_target_module_id = uuid7()
    field.relationship_multiple_targets = False
    field.relationship_multiple_sources = False

    with pytest.raises(RecordValidationError) as raised:
        validate_record_mutation(
            {str(field.id): requested_value},
            {str(field.id): "legacy"},
            [field],
        )

    assert [issue.code for issue in raised.value.issues] == [expected_code]


def test_record_create_and_update_persist_normalized_decimal_values() -> None:
    module = make_module()
    field = make_field(
        module.id,
        FieldType.DECIMAL,
        config={"minimum": "0", "maximum": "10"},
    )
    record = Record(module_id=module.id, data={})
    record.id = uuid7()
    db = Mock(spec=Session)
    db.scalar.return_value = module
    db.get.return_value = module
    db.scalars.return_value.all.return_value = [field]

    created = create_record(
        RecordCreate(module_id=module.id, data={str(field.id): "1.2300"}),
        Mock(),
        db,
    )
    assert created.data == {str(field.id): "1.23"}

    db.get.side_effect = lambda model, *_args, **_kwargs: (
        module if model is Module else record
    )
    update_record(
        record.id,
        RecordUpdate(data={str(field.id): "2.500"}),
        Mock(),
        db,
    )
    assert record.data == {str(field.id): "2.5"}


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
        with pytest.raises(ValueError):
            validate_field_value(field, case["valid"])

    with pytest.raises(ValueError):
        validate_field_value(field, case["invalid"])


def test_required_text_rejects_empty_string() -> None:
    field = make_field(uuid7(), required=True)

    with pytest.raises(ValueError, match="required"):
        validate_field_value(field, "")


def test_record_patch_rejects_type_changed_closed_integer_value() -> None:
    module = make_module()
    closed = make_field(module.id, FieldType.INTEGER, deleted=True)
    record = Record(module_id=module.id, data={str(closed.id): 1})
    record.id = uuid7()
    db = Mock(spec=Session)
    db.get.side_effect = lambda model, *_args, **_kwargs: (
        module if model is Module else record
    )
    db.scalar.return_value = module
    db.scalars.return_value.all.return_value = [closed]

    update_record(
        record.id,
        RecordUpdate(data={str(closed.id): 1}),
        Mock(),
        db,
    )
    assert record.data == {str(closed.id): 1}

    with pytest.raises(HTTPException) as raised:
        update_record(
            record.id,
            RecordUpdate(data={str(closed.id): True}),
            Mock(),
            db,
        )

    assert raised.value.status_code == 409
    assert raised.value.detail["errors"][0]["code"] == "closed_field_mutation"
    assert record.data == {str(closed.id): 1}
