from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.fields.validation import (
    field_config,
    validate_field_value,
    validate_module_schema,
)
from tests.catalog.field_record_support import _make_validation_client, make_field, make_module


def test_field_config_rejects_invalid_select_options() -> None:
    with pytest.raises(ValueError):
        field_config(FieldType.SELECT, {})
    with pytest.raises(ValueError):
        field_config(FieldType.SELECT, {"options": ["open", "open"]})


def test_select_option_ids_are_stable_values_and_duplicate_labels_are_rejected() -> None:
    first_id, second_id = str(uuid7()), str(uuid7())
    options = [
        {"id": first_id, "label": "Open"},
        {"id": second_id, "label": "Closed"},
    ]
    config = field_config(
        FieldType.SELECT, {"options": options, "defaultValue": first_id}
    )
    field = make_field(uuid7(), FieldType.SELECT, config=config)
    assert validate_field_value(field, first_id) == first_id
    with pytest.raises(ValueError):
        validate_field_value(field, "Open")
    with pytest.raises(ValueError):
        validate_field_value(field, str(uuid7()))
    with pytest.raises(ValueError):
        field_config(FieldType.SELECT, {"options": [{"id": first_id, "label": "Open"}] * 2})
    with pytest.raises(ValueError):
        field_config(
            FieldType.SELECT,
            {"options": [{"id": first_id, "label": "Open"}, {"id": second_id, "label": "Open"}]},
        )


@pytest.mark.parametrize(
    ("field_type", "config"),
    [
        (FieldType.TEXT, {"options": ["open"]}),
        (FieldType.NUMBER, {"minLength": 1}),
        (FieldType.DECIMAL, {"options": ["open"]}),
        (FieldType.INTEGER, {"minLength": 1}),
        (FieldType.BOOLEAN, {"minimum": 0}),
        (FieldType.DATE, {"minLength": 1}),
        (FieldType.DATETIME, {"options": ["open"]}),
        (FieldType.SELECT, {"minimum": 0}),
        (FieldType.RELATIONSHIP, {"options": ["open"]}),
    ],
)
def test_field_config_rejects_cross_type_configuration(
    field_type: FieldType, config: dict[str, object]
) -> None:
    with pytest.raises(ValueError):
        field_config(field_type, config)


def test_record_route_rejects_numeric_json_for_decimal_field() -> None:
    module = make_module()
    field = make_field(module.id, FieldType.DECIMAL)
    db = Mock(spec=Session)
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
    with pytest.raises(ValueError):
        validate_module_schema([first, second])

    second.position = 1
    second.name = "  "
    with pytest.raises(ValueError):
        validate_module_schema([first, second])

    second.name = first.name
    with pytest.raises(ValueError):
        validate_module_schema([first, second])

    with pytest.raises(ValueError):
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
    with pytest.raises(ValueError):
        validate_module_schema([field])

    field = make_field(module_id, FieldType.RELATIONSHIP)
    with pytest.raises(ValueError):
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

    with pytest.raises(ValueError, match=message):
        validate_module_schema([field])
