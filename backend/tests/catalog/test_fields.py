import json
from typing import Any
from unittest.mock import Mock
from uuid import UUID

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.fields.validation import (
    field_config,
    validate_field_value,
    validate_module_schema,
    validate_relationship_metadata,
)
from tests.catalog.field_record_support import _make_validation_client, make_field, make_module


def test_field_config_rejects_invalid_select_options() -> None:
    with pytest.raises(ValueError, match="Select fields require a non-empty options list"):
        field_config(FieldType.SELECT, {})
    with pytest.raises(ValueError, match="Select options need IDs and labels"):
        field_config(FieldType.SELECT, {"options": ["open", "open"]})


def test_select_option_ids_are_stable_values_and_duplicate_labels_are_rejected() -> None:
    first_id, second_id = str(uuid7()), str(uuid7())
    options = [
        {"id": first_id, "label": "Open"},
        {"id": second_id, "label": "Closed"},
    ]
    config = field_config(FieldType.SELECT, {"options": options, "defaultValue": first_id})
    field = make_field(uuid7(), FieldType.SELECT, config=config)
    assert validate_field_value(field, first_id) == first_id
    not_an_option = f"Field {field.id} must be one of the configured options"
    with pytest.raises(ValueError, match=not_an_option):
        validate_field_value(field, "Open")
    with pytest.raises(ValueError, match=not_an_option):
        validate_field_value(field, str(uuid7()))
    with pytest.raises(ValueError, match="Select option IDs and labels must be unique"):
        field_config(FieldType.SELECT, {"options": [{"id": first_id, "label": "Open"}] * 2})
    with pytest.raises(ValueError, match="Select option IDs and labels must be unique"):
        field_config(
            FieldType.SELECT,
            {"options": [{"id": first_id, "label": "Open"}, {"id": second_id, "label": "Open"}]},
        )


@pytest.mark.parametrize(
    ("field_type", "config", "message"),
    [
        (
            FieldType.TEXT,
            {"options": ["open"]},
            "Text fields only support minLength, maxLength, and defaultValue configuration",
        ),
        (
            FieldType.NUMBER,
            {"minLength": 1},
            "Numeric fields only support minimum, maximum, step, and defaultValue configuration",
        ),
        (
            FieldType.DECIMAL,
            {"options": ["open"]},
            "Decimal fields only support minimum and maximum configuration",
        ),
        (
            FieldType.INTEGER,
            {"minLength": 1},
            "Numeric fields only support minimum, maximum, step, and defaultValue configuration",
        ),
        (
            FieldType.BOOLEAN,
            {"minimum": 0},
            "Boolean fields only support defaultValue configuration",
        ),
        (
            FieldType.DATE,
            {"minLength": 1},
            "Date fields only support earliest, latest, and defaultValue configuration",
        ),
        (
            FieldType.DATETIME,
            {"options": ["open"]},
            "Date fields only support earliest, latest, and defaultValue configuration",
        ),
        (FieldType.SELECT, {"minimum": 0}, "Select fields require a non-empty options list"),
        (
            FieldType.RELATIONSHIP,
            {"options": ["open"]},
            "This field type does not support configuration",
        ),
    ],
)
def test_field_config_rejects_cross_type_configuration(
    field_type: FieldType, config: dict[str, object], message: str
) -> None:
    with pytest.raises(ValueError, match=f"^{message}$"):
        field_config(field_type, config)


def test_record_route_rejects_numeric_json_for_decimal_field() -> None:
    module = make_module()
    field = make_field(module.id, FieldType.DECIMAL)
    db = Mock(spec=Session)
    db.info = {}  # a real Session.info is a dict; the lock helper keeps a marker in it
    db.scalar.return_value = module
    db.get.return_value = module
    db.scalars.return_value.all.return_value = [field]
    client = _make_validation_client(db=db)

    response = client.post(
        "/api/records",
        json={
            "module_id": str(module.id),
            "data": {str(field.id): 1.25},
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["errors"][0]["code"] == "invalid_field_value"
    db.add.assert_not_called()


def test_module_schema_validator_checks_active_field_structure() -> None:
    module_id = uuid7()
    first = make_field(module_id)
    second = make_field(module_id)
    second.name = "Summary"
    second.position = 1

    validate_module_schema([first, second])

    second.position = 3
    with pytest.raises(ValueError, match="^Field positions must be contiguous and zero-based$"):
        validate_module_schema([first, second])

    second.position = 1
    second.name = "  "
    with pytest.raises(ValueError, match="^Field names must be non-blank$"):
        validate_module_schema([first, second])

    second.name = first.name
    with pytest.raises(ValueError, match="^Field names must be unique$"):
        validate_module_schema([first, second])

    with pytest.raises(ValueError, match="^Module schemas require at least one active field$"):
        validate_module_schema([])


def test_module_schema_validator_reuses_field_config_and_relationship_metadata() -> None:
    module_id = uuid7()
    field = make_field(
        module_id,
        FieldType.SELECT,
        config={"options": [{"id": str(uuid7()), "label": "open"}]},
    )
    validate_module_schema([field])

    field.config = {"options": []}
    with pytest.raises(ValueError, match="Select fields require a non-empty options list"):
        validate_module_schema([field])

    field = make_field(module_id, FieldType.RELATIONSHIP)
    with pytest.raises(
        ValueError, match="^Relationship fields have invalid relationship metadata$"
    ):
        validate_module_schema([field])
    field.relationship_target_module_id = uuid7()
    field.relationship_multiple_targets = False
    field.relationship_multiple_sources = True
    validate_module_schema([field])


@pytest.mark.parametrize(
    ("attribute", "value", "message"),
    [
        ("position", True, "Field positions must be nonnegative integers"),
        ("position", -1, "Field positions must be nonnegative integers"),
        ("type", "unsupported", "Field types are unsupported"),
        ("config", [], "Field configuration must be an object"),
    ],
)
def test_module_schema_rejects_malformed_persisted_field_shape(
    attribute: str, value: object, message: str
) -> None:
    field = make_field(uuid7())
    if attribute == "config":
        # The ORM normally rejects this assignment; persisted legacy rows may still contain it.
        field.__dict__[attribute] = value
    else:
        setattr(field, attribute, value)

    with pytest.raises(ValueError, match=f"^{message}$"):
        validate_module_schema([field])


OPTION_ID = "0192f0c4-6b1e-7c3a-9d2e-4f5a6b7c8d9e"
OTHER_OPTION_ID = "0192f0c4-6b1e-7c3a-9d2e-4f5a6b7c8d9f"


@pytest.mark.parametrize(
    ("field_type", "config", "message"),
    [
        # Numeric bounds, steps, and defaults.
        (FieldType.NUMBER, {"minimum": "zero"}, "Numeric field minimum must be a finite number"),
        (FieldType.NUMBER, {"maximum": True}, "Numeric field maximum must be a finite number"),
        (FieldType.NUMBER, {"step": "half"}, "Numeric field step must be a finite number"),
        (
            FieldType.NUMBER,
            {"defaultValue": float("inf")},
            "Numeric field defaultValue must be a finite number",
        ),
        (
            FieldType.NUMBER,
            {"minimum": 2, "maximum": 1},
            "Numeric field minimum cannot exceed maximum",
        ),
        (FieldType.NUMBER, {"step": 0}, "Numeric field step must be a positive finite number"),
        (FieldType.NUMBER, {"step": -1}, "Numeric field step must be a positive finite number"),
        (
            FieldType.NUMBER,
            {"minimum": 2, "defaultValue": 1},
            "Numeric field defaultValue is below its minimum",
        ),
        (
            FieldType.NUMBER,
            {"maximum": 2, "defaultValue": 3},
            "Numeric field defaultValue exceeds its maximum",
        ),
        (
            FieldType.NUMBER,
            {"minimum": 0, "step": 2, "defaultValue": 3},
            "Numeric field defaultValue does not match field step",
        ),
        # Integer configuration must be whole, key by key.
        (FieldType.INTEGER, {"minimum": 0.5}, "Integer field configuration must use whole numbers"),
        (FieldType.INTEGER, {"maximum": 0.5}, "Integer field configuration must use whole numbers"),
        (FieldType.INTEGER, {"step": 0.5}, "Integer field configuration must use whole numbers"),
        (
            FieldType.INTEGER,
            {"defaultValue": 0.5},
            "Integer field configuration must use whole numbers",
        ),
        # Decimal bounds.
        (
            FieldType.DECIMAL,
            {"minimum": "2", "maximum": "1"},
            "Decimal field minimum cannot exceed maximum",
        ),
        # Select options.
        (
            FieldType.SELECT,
            {"options": [{"id": OPTION_ID, "label": "Open"}], "minimum": 0},
            "Select fields require a non-empty options list",
        ),
        (
            FieldType.SELECT,
            {"options": [{"id": OPTION_ID}]},
            "Select options need IDs and labels",
        ),
        (
            FieldType.SELECT,
            {"options": [{"id": 5, "label": "Open"}]},
            "Select option IDs and labels must be non-empty strings",
        ),
        (
            FieldType.SELECT,
            {"options": [{"id": OPTION_ID, "label": "  "}]},
            "Select option IDs and labels must be non-empty strings",
        ),
        (
            FieldType.SELECT,
            {"options": [{"id": OPTION_ID.upper(), "label": "Open"}]},
            "Select option IDs must be canonical UUIDs",
        ),
        (
            FieldType.SELECT,
            {"options": [{"id": OPTION_ID, "label": "x" * 101}]},
            "Select option labels may have at most 100 characters",
        ),
        (
            FieldType.SELECT,
            {"options": [{"id": OPTION_ID, "label": "Open"}] * 2},
            "Select option IDs and labels must be unique",
        ),
        (
            FieldType.SELECT,
            {"options": [{"id": OPTION_ID, "label": "Open"}], "defaultValue": OTHER_OPTION_ID},
            "Select defaultValue must be one of the configured options",
        ),
        # Text lengths and defaults.
        (FieldType.TEXT, {"minLength": -1}, "Text field minLength must be a nonnegative integer"),
        (FieldType.TEXT, {"maxLength": True}, "Text field maxLength must be a nonnegative integer"),
        (
            FieldType.TEXT,
            {"minLength": 5, "maxLength": 4},
            "Text field minLength cannot exceed maxLength",
        ),
        (FieldType.TEXT, {"defaultValue": 5}, "Text field defaultValue must be text"),
        (
            FieldType.TEXT,
            {"minLength": 2, "defaultValue": "x"},
            "Text field defaultValue is shorter than minLength",
        ),
        (
            FieldType.LONG_TEXT,
            {"maxLength": 3, "defaultValue": "long"},
            "Text field defaultValue exceeds maxLength",
        ),
        (
            FieldType.EMAIL,
            {"defaultValue": "not-an-email"},
            "Email field defaultValue must be an email address",
        ),
        (
            FieldType.URL,
            {"defaultValue": "ftp://example.test"},
            "URL field defaultValue must be an http or https URL",
        ),
        # Date limits and defaults.
        (FieldType.DATE, {"earliest": "nope"}, "Date field earliest must be valid ISO syntax"),
        (FieldType.DATETIME, {"latest": 5}, "Date field latest must be valid ISO syntax"),
        (
            FieldType.DATE,
            {"earliest": "2026-02-01", "latest": "2026-01-01"},
            "Date field earliest cannot exceed latest",
        ),
        (
            FieldType.DATE,
            {"latest": "2026-01-31", "defaultValue": "2026-02-01"},
            "Date field defaultValue must be within earliest and latest",
        ),
        # Boolean defaults.
        (FieldType.BOOLEAN, {"defaultValue": "yes"}, "Boolean field defaultValue must be boolean"),
    ],
)
def test_field_config_refuses_invalid_configuration(
    field_type: FieldType, config: dict[str, object], message: str
) -> None:
    with pytest.raises(ValueError, match=f"^{message}$"):
        field_config(field_type, config)


def test_numeric_configuration_names_the_first_invalid_key_in_a_fixed_order() -> None:
    # The publish review shows this message as sent, so it must not depend on the
    # process hash seed when several keys are invalid.
    config = {"defaultValue": "d", "step": "s", "maximum": "x", "minimum": "n"}

    with pytest.raises(ValueError, match="^Numeric field minimum must be a finite number$"):
        field_config(FieldType.NUMBER, config)


@pytest.mark.parametrize(
    ("field_type", "config"),
    [
        (FieldType.NUMBER, {"defaultValue": None}),
        (FieldType.NUMBER, {"minimum": 1, "maximum": 1, "defaultValue": 1}),
        (FieldType.NUMBER, {"minimum": 0.5, "step": 0.5}),
        (FieldType.DECIMAL, {"minimum": "1", "maximum": "1"}),
        (FieldType.SELECT, {"options": [{"id": OPTION_ID, "label": "x" * 100}]}),
        (FieldType.TEXT, {"minLength": 0}),
        (FieldType.TEXT, {"minLength": 2, "maxLength": 2, "defaultValue": "ab"}),
        (FieldType.EMAIL, {"defaultValue": "ops@example.test"}),
        (FieldType.URL, {"defaultValue": "https://example.test/path"}),
        (FieldType.BOOLEAN, {}),
        (FieldType.BOOLEAN, {"defaultValue": True}),
    ],
)
def test_field_config_accepts_configuration_on_its_limits(
    field_type: FieldType, config: dict[str, object]
) -> None:
    assert field_config(field_type, dict(config)) == config


def test_integer_configuration_is_stored_as_whole_json_numbers() -> None:
    normalized = field_config(
        FieldType.INTEGER,
        {"minimum": 0.0, "maximum": 10.0, "step": 2.0, "defaultValue": 4.0},
    )

    assert json.dumps(normalized, sort_keys=True) == (
        '{"defaultValue": 4, "maximum": 10, "minimum": 0, "step": 2}'
    )


@pytest.mark.parametrize(
    ("field_type", "metadata", "required", "config", "message"),
    [
        (
            FieldType.RELATIONSHIP,
            (None, False, False),
            False,
            {},
            "Relationship fields have invalid relationship metadata",
        ),
        (
            FieldType.RELATIONSHIP,
            (OPTION_ID, "yes", False),
            False,
            {},
            "Relationship fields have invalid relationship metadata",
        ),
        (
            FieldType.RELATIONSHIP,
            (OPTION_ID, False, "yes"),
            False,
            {},
            "Relationship fields have invalid relationship metadata",
        ),
        (
            FieldType.RELATIONSHIP,
            (OPTION_ID, False, False),
            True,
            {},
            "Relationship fields have invalid relationship metadata",
        ),
        (
            FieldType.RELATIONSHIP,
            (OPTION_ID, False, False),
            False,
            {"maxLength": 1},
            "Relationship fields have invalid relationship metadata",
        ),
        (
            FieldType.TEXT,
            (None, False, None),
            False,
            {},
            "Primitive fields have invalid relationship metadata",
        ),
    ],
)
def test_relationship_metadata_refuses_each_invalid_part(
    field_type: FieldType,
    metadata: tuple[str | None, Any, Any],
    required: bool,
    config: dict[str, object],
    message: str,
) -> None:
    field = make_field(uuid7(), field_type, required=required, config=config)
    target, multiple_targets, multiple_sources = metadata
    field.relationship_target_module_id = UUID(target) if target else None
    field.relationship_multiple_targets = multiple_targets
    field.relationship_multiple_sources = multiple_sources

    with pytest.raises(ValueError, match=f"^{message}$"):
        validate_relationship_metadata(field)
