import json
from datetime import UTC, datetime
from pathlib import Path
from secrets import token_urlsafe
from typing import Any
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.fields.validation import (
    field_config,
    validate_field_value,
    validate_record_data,
)
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.mutation_validation import (
    RecordValidationError,
    validate_record_mutation,
)
from app.systems.sandbox.records.router import update_record
from app.systems.sandbox.records.schemas import RecordUpdate
from tests.catalog.field_record_support import make_field, make_module
from tests.rbac.support import make_user

REJECTED_VALUE_CANARY = token_urlsafe(32)


def _load_record_field_validation_cases() -> list[dict[str, Any]]:
    fixture_path = (
        Path(__file__).resolve().parents[3] / "contracts" / ("record-field-validation-cases.json")
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
    with pytest.raises(ValueError):
        field_config(FieldType.DECIMAL, {"maximum": "1" * 39})
    with pytest.raises(ValueError):
        field_config(FieldType.DECIMAL, {"maximum": "1." + "1" * 19})
    assert field_config(FieldType.DECIMAL, {"minimum": "0.00"}) == {"minimum": "0"}
    with pytest.raises(ValueError):
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
    with pytest.raises(ValueError):
        validate_field_value(text_field, "x")
    with pytest.raises(ValueError):
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


@pytest.mark.parametrize(
    ("field_type", "config", "value", "message"),
    [
        (FieldType.NUMBER, {"minimum": 2}, 1, "below its minimum"),
        (FieldType.NUMBER, {"maximum": 0}, 1, "exceeds its maximum"),
        (FieldType.NUMBER, {"minimum": "zero"}, 1, "invalid numeric configuration"),
        (FieldType.DECIMAL, {"minimum": "2"}, "1", "below its minimum"),
        (FieldType.DECIMAL, {"minimum": 0}, "1", "invalid decimal configuration"),
        (FieldType.SELECT, {}, "open", "configured options"),
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

    update_record(
        record.id,
        RecordUpdate(data={str(closed.id): 1}),
        make_user("record_writer"),
        db,
        if_match=record.updated_at.isoformat(),
    )
    assert record.data == {str(closed.id): 1}

    with pytest.raises(HTTPException) as raised:
        update_record(
            record.id,
            RecordUpdate(data={str(closed.id): True}),
            make_user("record_writer"),
            db,
            if_match=record.updated_at.isoformat(),
        )

    assert raised.value.status_code == 409
    assert raised.value.detail["errors"][0]["code"] == "closed_field_mutation"
    assert record.data == {str(closed.id): 1}
