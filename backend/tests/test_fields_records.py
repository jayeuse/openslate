from datetime import UTC, datetime
from unittest.mock import Mock, patch
from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.listing import StandardListRequest
from app.core.database import model_registry  # noqa: F401
from app.systems.fields.models import Field, FieldType
from app.systems.fields.router import (
    create_field,
    delete_field,
    module_fields_router,
    reorder_module_fields,
    restore_field,
    update_field,
)
from app.systems.fields.router import router as fields_router
from app.systems.fields.schemas import FieldCreate, FieldReorder, FieldUpdate
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
from app.systems.records.router import router as records_router
from app.systems.records.schemas import RecordCreate, RecordUpdate
from app.systems.relationships.service import RelationshipConflict, RelationshipUnavailable


def make_module(*, deleted: bool = False) -> Module:
    module = Module(department_id=uuid7(), module_name="Assets", is_deleted=deleted)
    module.id = uuid7()
    return module


def make_field(
    module_id: UUID,
    field_type: FieldType = FieldType.TEXT,
    *,
    required: bool = False,
    config: dict[str, object] | None = None,
    deleted: bool = False,
) -> Field:
    field = Field(
        module_id=module_id,
        name="Title",
        type=field_type,
        required=required,
        position=0,
        config=config or {},
        is_deleted=deleted,
    )
    field.id = uuid7()
    return field


def test_routers_expose_crud_restore_and_reorder_contract() -> None:
    app = FastAPI()
    app.include_router(fields_router, prefix="/api")
    app.include_router(module_fields_router, prefix="/api")
    app.include_router(records_router, prefix="/api")
    client = TestClient(app)

    paths = client.get("/openapi.json").json()["paths"]
    assert set(paths["/api/fields"]) == {"get", "post"}
    assert set(paths["/api/fields/{field_id}"]) == {"get", "patch", "delete"}
    assert set(paths["/api/fields/{field_id}/restore"]) == {"post"}
    assert set(paths["/api/modules/{module_id}/fields/reorder"]) == {"post"}
    assert set(paths["/api/records"]) == {"get", "post"}
    assert set(paths["/api/records/{record_id}"]) == {"get", "patch", "delete"}
    assert set(paths["/api/records/{record_id}/restore"]) == {"post"}


@pytest.mark.parametrize(
    ("field_type", "config"),
    [
        (FieldType.TEXT, {}),
        (FieldType.NUMBER, {}),
        (FieldType.BOOLEAN, {}),
        (FieldType.DATE, {}),
        (FieldType.DATETIME, {}),
        (FieldType.SELECT, {"options": ["open", "closed"]}),
    ],
)
def test_field_schema_accepts_the_six_types(
    field_type: FieldType, config: dict[str, object]
) -> None:
    payload = FieldCreate(
        module_id=uuid7(),
        name="  Status  ",
        type=field_type,
        position=0,
        config=config,
    )
    assert payload.name == "Status"
    assert payload.type is field_type


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
    with pytest.raises(ValueError):
        FieldCreate(
            module_id=uuid7(),
            name="Status",
            type=FieldType.TEXT,
            position=0,
            config={"options": ["open"]},
        )


def test_field_create_requires_active_module_and_checks_name_and_position() -> None:
    module = make_module()
    db = Mock(spec=Session)
    db.scalar.side_effect = [module, None, None]

    field = create_field(
        FieldCreate(module_id=module.id, name="  Title  ", type="text", position=0),
        Mock(),
        db,
    )

    assert field.name == "Title"
    assert field.module_id == module.id
    db.commit.assert_called_once()


@pytest.mark.parametrize(
    ("lock_error", "status_code"),
    [(RelationshipConflict("A relationship module is unavailable"), 409),
     (RelationshipUnavailable("Relationship operation is temporarily unavailable"), 503)],
)
def test_relationship_field_create_translates_target_lock_failures(
    lock_error: Exception, status_code: int
) -> None:
    source_module = make_module()
    db = Mock(spec=Session)
    db.scalar.return_value = source_module
    payload = FieldCreate(
        module_id=source_module.id,
        name="Related asset",
        type=FieldType.RELATIONSHIP,
        position=0,
        relationship_target_module_id=uuid7(),
        relationship_multiple_targets=False,
        relationship_multiple_sources=False,
    )

    with patch(
        "app.systems.fields.router.lock_modules",
        side_effect=lock_error,
    ):
        with pytest.raises(HTTPException) as error:
            create_field(payload, Mock(), db)

    assert error.value.status_code == status_code
    db.add.assert_not_called()
    db.commit.assert_not_called()


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


def test_field_delete_rejects_active_records_and_restore_checks_parent() -> None:
    module = make_module()
    field = make_field(module.id)
    db = Mock(spec=Session)
    db.get.return_value = field
    db.scalar.return_value = 1

    with pytest.raises(HTTPException) as error:
        delete_field(field.id, Mock(), db)
    assert error.value.status_code == 409
    assert field.is_deleted is False

    deleted = make_field(module.id, deleted=True)
    db.get.return_value = deleted
    db.scalar.return_value = None
    with pytest.raises(HTTPException) as error:
        restore_field(deleted.id, Mock(), db)
    assert error.value.status_code == 409
    assert deleted.is_deleted is True


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
