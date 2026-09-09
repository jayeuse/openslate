from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.listing import StandardListRequest
from app.systems.fields.models import FieldType
from app.systems.fields.validation import validate_field_value, validate_record_data
from app.systems.modules.models import Module
from app.systems.records.models import Record
from app.systems.records.router import (
    RecordSortField,
    create_record,
    delete_record,
    list_records,
    restore_record,
    update_record,
)
from app.systems.records.schemas import RecordCreate, RecordUpdate
from tests.field_record_support import make_field, make_module


def test_records_do_not_offer_json_search() -> None:
    db = Mock(spec=Session)
    with pytest.raises(HTTPException) as error:
        list_records(
            Mock(),
            db,
            StandardListRequest[RecordSortField](search="secret"),
        )
    assert error.value.status_code == 422


def test_record_delete_soft_deletes() -> None:
    module = make_module()
    record = Record(module_id=module.id, data={})
    record.id = uuid7()
    db = Mock(spec=Session)
    db.get.side_effect = lambda model, *_args, **_kwargs: (
        module if model is Module else record
    )

    delete_record(record.id, Mock(), db)

    assert record.is_deleted is True
    assert record.deleted_at is not None
    db.commit.assert_called_once()


def test_record_validation_enforces_keys_required_null_and_types() -> None:
    module = make_module()
    fields = [
        make_field(module.id, FieldType.TEXT, required=True),
        make_field(module.id, FieldType.NUMBER),
        make_field(module.id, FieldType.BOOLEAN),
        make_field(module.id, FieldType.DATE),
        make_field(module.id, FieldType.DATETIME),
        make_field(module.id, FieldType.SELECT, config={"options": ["open"]}),
    ]
    data = {
        str(fields[0].id): "Title",
        str(fields[1].id): 2.5,
        str(fields[2].id): True,
        str(fields[3].id): "2026-08-19",
        str(fields[4].id): "2026-08-19T12:00:00+00:00",
        str(fields[5].id): "open",
    }
    validate_record_data(data, fields)

    with pytest.raises(ValueError):
        validate_record_data({str(fields[1].id): 1, str(uuid7()): "unknown"}, fields)
    with pytest.raises(ValueError):
        validate_record_data({str(fields[0].id): None}, fields)
    with pytest.raises(ValueError):
        validate_field_value(fields[1], True)
    with pytest.raises(ValueError):
        validate_field_value(fields[3], "19/08/2026")
    with pytest.raises(ValueError):
        validate_field_value(fields[5], "closed")
    assert fields[0].required is True


def test_record_create_replaces_data_on_patch_and_restore_revalidates() -> None:
    module = make_module()
    field = make_field(module.id, required=True)
    record = Record(module_id=module.id, data={str(field.id): "Old"})
    record.id = uuid7()
    db = Mock(spec=Session)
    db.scalar.return_value = module
    db.get.return_value = module
    db.scalars.return_value.all.return_value = [field]

    created = create_record(
        RecordCreate(module_id=module.id, data={str(field.id): "New"}),
        Mock(),
        db,
    )
    assert created.data == {str(field.id): "New"}

    db.get.side_effect = lambda model, *_args, **_kwargs: (
        module if model is Module else record
    )
    update_record(
        record.id,
        RecordUpdate(data={str(field.id): "Replacement"}),
        Mock(),
        db,
    )
    assert record.data == {str(field.id): "Replacement"}

    record.is_deleted = True
    record.deleted_at = datetime.now(UTC)
    record.data = {}
    with pytest.raises(HTTPException) as error:
        restore_record(record.id, Mock(), db)
    assert error.value.status_code == 422


def test_record_update_replaces_active_values_instead_of_merging_them() -> None:
    module = make_module()
    first = make_field(module.id)
    second = make_field(module.id, FieldType.INTEGER)
    record = Record(
        module_id=module.id,
        data={str(first.id): "old", str(second.id): 1},
    )
    record.id = uuid7()
    db = Mock(spec=Session)
    db.get.side_effect = lambda model, *_args, **_kwargs: (
        module if model is Module else record
    )
    db.scalar.return_value = module
    db.scalars.return_value.all.return_value = [first, second]

    update_record(
        record.id,
        RecordUpdate(data={str(second.id): 2}),
        Mock(),
        db,
    )

    assert record.data == {str(second.id): 2}


def test_relationship_values_are_rejected_on_record_create_and_update() -> None:
    module = make_module()
    relationship = make_field(module.id, FieldType.RELATIONSHIP)
    relationship.relationship_target_module_id = uuid7()
    relationship.relationship_multiple_targets = False
    relationship.relationship_multiple_sources = False
    relationship_key = str(relationship.id)

    create_db = Mock(spec=Session)
    create_db.scalar.return_value = module
    create_db.get.return_value = module
    create_db.scalars.return_value.all.return_value = [relationship]
    with pytest.raises(HTTPException) as create_error:
        create_record(
            RecordCreate(module_id=module.id, data={relationship_key: "record-id"}),
            Mock(),
            create_db,
        )

    assert create_error.value.status_code == 422
    assert create_error.value.detail["errors"][0]["code"] == "relationship_field"
    create_db.add.assert_not_called()

    record = Record(module_id=module.id, data={})
    record.id = uuid7()
    update_db = Mock(spec=Session)
    update_db.get.side_effect = lambda model, *_args, **_kwargs: (
        module if model is Module else record
    )
    update_db.scalar.return_value = module
    update_db.scalars.return_value.all.return_value = [relationship]
    with pytest.raises(HTTPException) as update_error:
        update_record(
            record.id,
            RecordUpdate(data={relationship_key: "record-id"}),
            Mock(),
            update_db,
        )

    assert update_error.value.status_code == 422
    assert update_error.value.detail["errors"][0]["code"] == "relationship_field"
    assert record.data == {}
    update_db.commit.assert_not_called()


def test_record_create_requires_an_accepted_schema_after_module_lock() -> None:
    module = make_module()
    module.is_schema_accepted = False
    db = Mock(spec=Session)
    db.scalar.return_value = module
    db.get.return_value = module

    with pytest.raises(HTTPException) as error:
        create_record(RecordCreate(module_id=module.id, data={}), Mock(), db)

    assert error.value.status_code == 409
    assert error.value.detail == "Module schema is not accepted"
    db.add.assert_not_called()


def test_record_create_rejects_an_accepted_module_without_active_fields_after_module_lock() -> None:
    module = make_module()
    db = Mock(spec=Session)
    db.scalar.return_value = module
    db.get.return_value = module
    db.scalars.return_value.all.return_value = []

    with pytest.raises(HTTPException) as error:
        create_record(RecordCreate(module_id=module.id, data={}), Mock(), db)

    assert error.value.status_code == 409
    assert error.value.detail == "Module schema is not accepted"
    db.add.assert_not_called()


def test_record_patch_preserves_closed_field_values_and_rejects_changes() -> None:
    module = make_module()
    active = make_field(module.id)
    closed = make_field(module.id, deleted=True)
    closed.name = "Legacy title"
    record = Record(
        module_id=module.id,
        data={str(active.id): "old", str(closed.id): "legacy"},
    )
    record.id = uuid7()
    db = Mock(spec=Session)
    db.get.side_effect = lambda model, *_args, **_kwargs: (
        module if model is Module else record
    )
    db.scalar.return_value = module
    db.scalars.return_value.all.return_value = [active, closed]

    update_record(
        record.id,
        RecordUpdate(data={str(active.id): "new", str(closed.id): "legacy"}),
        Mock(),
        db,
    )
    assert record.data == {str(active.id): "new", str(closed.id): "legacy"}

    with pytest.raises(HTTPException) as raised:
        update_record(
            record.id,
            RecordUpdate(data={str(active.id): "newer", str(closed.id): "changed"}),
            Mock(),
            db,
        )
    assert raised.value.status_code == 409
    assert raised.value.detail == {
        "code": "record_validation_failed",
        "message": "Record data is invalid",
        "errors": [
            {
                "code": "closed_field_mutation",
                "field_id": str(closed.id),
                "message": "Closed field values cannot be changed",
            }
        ],
        "truncated": False,
    }
