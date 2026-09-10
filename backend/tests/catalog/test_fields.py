from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.fields.models import FieldType
from app.systems.fields.router import (
    reorder_module_fields,
    update_field,
)
from app.systems.fields.schemas import FieldCreate, FieldReorder, FieldUpdate
from app.systems.fields.validation import (
    field_config,
    validate_module_schema,
)
from app.systems.records.models import Record
from tests.catalog.field_record_support import _make_validation_client, make_field, make_module


def test_field_schema_rejects_invalid_configuration() -> None:
    with pytest.raises(ValueError):
        FieldCreate(module_id=uuid7(), name="Status", type=FieldType.SELECT, position=0)
    with pytest.raises(ValueError):
        FieldCreate(
            module_id=uuid7(),
            name="Status",
            type=FieldType.SELECT,
            position=0,
            config={"options": ["open", "open"]},
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


def test_field_route_returns_clean_422_for_unsupported_type() -> None:
    client = _make_validation_client()

    response = client.post(
        "/api/fields",
        json={
            "module_id": str(uuid7()),
            "name": "Status",
            "type": "unsupported",
            "position": 0,
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"][-1] == "type"


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
    field = make_field(module_id, FieldType.SELECT, config={"options": ["open"]})
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


def test_audit_redaction_only_change_preserves_schema_acceptance() -> None:
    module = make_module()
    field = make_field(module.id)
    db = Mock(spec=Session)
    db.scalar.return_value = module
    db.get.side_effect = [field, module, field]

    updated = update_field(field.id, FieldUpdate(audit_redacted=True), Mock(), db)

    assert updated.audit_redacted is True
    assert module.is_schema_accepted is True
    db.commit.assert_called_once()


def test_field_update_keeps_module_immutable_and_checks_existing_records() -> None:
    module = make_module()
    field = make_field(module.id)
    record = Record(module_id=module.id, data={str(field.id): "not-a-number"})
    db = Mock(spec=Session)
    db.get.return_value = field

    with pytest.raises(HTTPException) as error:
        update_field(field.id, FieldUpdate(module_id=uuid7()), Mock(), db)
    assert error.value.status_code == 409
    db.commit.assert_not_called()

    db.scalar.return_value = module
    db.scalars.return_value.all.return_value = [record]
    with pytest.raises(HTTPException) as error:
        update_field(field.id, FieldUpdate(type=FieldType.NUMBER), Mock(), db)
    assert error.value.status_code == 409
    assert field.type is FieldType.TEXT


def test_reorder_uses_temporary_positions_for_sparse_existing_positions() -> None:
    module = make_module()
    first = make_field(module.id)
    second = make_field(module.id)
    second.position = 5
    db = Mock(spec=Session)
    db.scalar.return_value = module
    db.scalars.return_value.all.return_value = [first, second]

    reordered = reorder_module_fields(
        module.id,
        FieldReorder(field_ids=[second.id, first.id]),
        Mock(),
        db,
    )

    assert reordered == [second, first]
    assert second.position == 0
    assert first.position == 1
    db.flush.assert_called_once()
