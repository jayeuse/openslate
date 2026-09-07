import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock, patch
from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.common.listing import StandardListRequest
from app.core.database import get_db, model_registry  # noqa: F401
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
from app.systems.fields.schemas import FieldCreate, FieldReorder, FieldResponse, FieldUpdate
from app.systems.fields.validation import (
    FIELD_VALIDATORS,
    field_config,
    validate_field_value,
    validate_module_schema,
    validate_record_data,
)
from app.systems.lifecycle.exceptions import LifecycleClosedAncestorError
from app.systems.lifecycle.schemas import LifecycleTargetType
from app.systems.modules.models import Module
from app.systems.records.models import Record
from app.systems.records.router import (
    RecordSortField,
    RecordValidationError,
    create_record,
    delete_record,
    list_records,
    restore_record,
    update_record,
    validate_record_mutation,
)
from app.systems.records.router import router as records_router
from app.systems.records.schemas import RecordCreate, RecordUpdate
from app.systems.relationships.service import RelationshipConflict, RelationshipUnavailable
from app.systems.users.models import UserRole


def _load_record_field_validation_cases() -> list[dict[str, Any]]:
    fixture_path = Path(__file__).resolve().parents[2] / "contracts" / (
        "record-field-validation-cases.json"
    )
    with fixture_path.open(encoding="utf-8") as fixture:
        return json.load(fixture)["cases"]


RECORD_FIELD_VALIDATION_CASES = _load_record_field_validation_cases()


def make_module(*, deleted: bool = False) -> Module:
    module = Module(
        department_id=uuid7(),
        module_name="Assets",
        is_deleted=deleted,
        is_schema_accepted=True,
    )
    module.id = uuid7()
    return module


def make_field(
    module_id: UUID,
    field_type: FieldType = FieldType.TEXT,
    *,
    required: bool = False,
    config: dict[str, object] | None = None,
    deleted: bool = False,
    audit_redacted: bool = False,
) -> Field:
    field = Field(
        module_id=module_id,
        name="Title",
        type=field_type,
        required=required,
        position=0,
        config=config or {},
        is_deleted=deleted,
        audit_redacted=audit_redacted,
    )
    field.id = uuid7()
    return field


def _make_validation_client(
    *, role: UserRole = UserRole.ADMIN, db: Session | None = None
) -> TestClient:
    app = FastAPI()
    app.include_router(fields_router, prefix="/api")
    app.include_router(records_router, prefix="/api")
    database = db or Mock(spec=Session)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        role=SimpleNamespace(role=role)
    )
    app.dependency_overrides[get_db] = lambda: database
    return TestClient(app)


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
        (FieldType.DECIMAL, {}),
        (FieldType.INTEGER, {}),
        (FieldType.BOOLEAN, {}),
        (FieldType.DATE, {}),
        (FieldType.DATETIME, {}),
        (FieldType.SELECT, {"options": ["open", "closed"]}),
    ],
)
def test_field_schema_accepts_primitive_types(
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


def test_field_schema_trims_name_and_enforces_one_to_150_character_boundaries() -> None:
    for length in (1, 150):
        raw_name = f" {'x' * length} "
        assert (
            FieldCreate(
                module_id=uuid7(),
                name=raw_name,
                type=FieldType.TEXT,
                position=0,
            ).name
            == "x" * length
        )
        assert FieldUpdate(name=raw_name).name == "x" * length

    for invalid_name in ("", "  ", "x" * 151):
        with pytest.raises(ValueError):
            FieldCreate(
                module_id=uuid7(),
                name=invalid_name,
                type=FieldType.TEXT,
                position=0,
            )
        with pytest.raises(ValueError):
            FieldUpdate(name=invalid_name)


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


def test_field_audit_redaction_defaults_and_is_patchable() -> None:
    module_id = uuid7()

    create_payload = FieldCreate(
        module_id=module_id,
        name="Secret",
        type=FieldType.TEXT,
        position=0,
    )

    assert create_payload.audit_redacted is False
    assert FieldUpdate().audit_redacted is None
    assert FieldUpdate(audit_redacted=True).audit_redacted is True

    response_field = make_field(module_id)
    response_field.audit_redacted = None
    response_field.created_at = datetime.now(UTC)
    response_field.updated_at = datetime.now(UTC)
    response = FieldResponse.model_validate(response_field, from_attributes=True)
    assert response.audit_redacted is False


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


def test_select_config_preserves_embedded_strings_and_requires_exact_values() -> None:
    config = {"options": ["  in progress  ", "comma,value", 'quoted"value', "é"]}

    assert field_config(FieldType.SELECT, config) == config
    field = make_field(uuid7(), FieldType.SELECT, config=config)
    for option in config["options"]:
        assert validate_field_value(field, option) == option

    with pytest.raises(ValueError):
        field_config(FieldType.SELECT, {"options": [" \t"]})
    with pytest.raises(ValueError):
        validate_field_value(field, "in progress")


@pytest.mark.parametrize(
    ("request_path", "payload"),
    [
        (
            "/api/fields",
            {
                "module_id": str(uuid7()),
                "name": "Status",
                "type": "text",
                "position": 0,
            },
        ),
        (
            "/api/records",
            {"module_id": str(uuid7()), "data": {}},
        ),
    ],
)
def test_field_and_record_routes_reject_non_admin_users(
    request_path: str, payload: dict[str, object]
) -> None:
    client = _make_validation_client(role=UserRole.MEMBER)

    response = client.post(request_path, json=payload)

    assert response.status_code == 403
    assert response.json()["detail"] == "Forbidden"


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


def test_top_level_extra_keys_are_ignored_by_field_and_record_schemas() -> None:
    field = FieldCreate.model_validate(
        {
            "module_id": str(uuid7()),
            "name": "Status",
            "type": "text",
            "position": 0,
            "unexpected": "ignored",
        }
    )
    record = RecordCreate.model_validate(
        {
            "module_id": str(uuid7()),
            "data": {},
            "unexpected": "ignored",
        }
    )

    assert "unexpected" not in field.model_dump()
    assert "unexpected" not in record.model_dump()


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


def test_field_create_requires_active_module_and_checks_name_and_position() -> None:
    module = make_module()
    db = Mock(spec=Session)
    db.scalar.side_effect = [module, None, None]

    field = create_field(
        FieldCreate(
            module_id=module.id,
            name="  Title  ",
            type="text",
            position=0,
            audit_redacted=True,
        ),
        Mock(),
        db,
    )

    assert field.name == "Title"
    assert field.module_id == module.id
    assert field.audit_redacted is True
    db.commit.assert_called_once()


def test_effective_field_lifecycle_changes_clear_schema_acceptance() -> None:
    module = make_module()
    field = make_field(module.id)

    db = Mock(spec=Session)
    db.scalar.side_effect = [module, None, None]
    db.get.return_value = module
    create_field(
        FieldCreate(module_id=module.id, name="Summary", type="text", position=1),
        Mock(),
        db,
    )
    assert module.is_schema_accepted is False

    module.is_schema_accepted = True
    db.reset_mock()
    db.scalar.side_effect = [module, None]
    db.get.side_effect = [field, module, field]
    update_field(field.id, FieldUpdate(name="Title"), Mock(), db)
    assert module.is_schema_accepted is True

    module.is_schema_accepted = True
    db.reset_mock()
    db.scalar.side_effect = [module, None]
    db.get.side_effect = [field, module, field]
    update_field(field.id, FieldUpdate(name="Summary"), Mock(), db)
    assert module.is_schema_accepted is False

    module.is_schema_accepted = True
    field.is_deleted = False
    db.reset_mock()
    db.scalar.side_effect = [module, 0]
    db.get.side_effect = [field, module, field]
    delete_field(field.id, Mock(), db)
    assert module.is_schema_accepted is False

    module.is_schema_accepted = True
    field.is_deleted = True
    db.reset_mock()
    db.scalar.side_effect = [module, None, None]
    db.get.side_effect = [field, module, field]
    with patch(
        "app.systems.fields.router.reopen_lifecycle",
        side_effect=lambda *_args: setattr(module, "is_schema_accepted", False),
    ):
        restore_field(field.id, SimpleNamespace(id=uuid7()), db)
    assert module.is_schema_accepted is False

    module.is_schema_accepted = True
    other = make_field(module.id)
    other.name = "Other"
    other.position = 1
    db.reset_mock()
    db.get.side_effect = None
    db.get.return_value = module
    db.scalars.return_value.all.return_value = [field, other]
    reorder_module_fields(
        module.id,
        FieldReorder(field_ids=[other.id, field.id]),
        Mock(),
        db,
    )
    assert module.is_schema_accepted is False


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
    with patch(
        "app.systems.fields.router.reopen_lifecycle",
        side_effect=LifecycleClosedAncestorError("closed ancestor"),
    ):
        with pytest.raises(Exception) as error:
            restore_field(deleted.id, SimpleNamespace(id=uuid7()), db)
    assert error.value.status_code == 409
    assert deleted.is_deleted is True


def test_field_restore_delegates_to_lifecycle_reopen_for_authenticated_actor() -> None:
    module = make_module()
    field = make_field(module.id, deleted=True)
    user = SimpleNamespace(id=uuid7())
    db = Mock(spec=Session)
    db.get.return_value = field

    with patch(
        "app.systems.fields.router.reopen_lifecycle",
        return_value=Mock(),
    ) as reopen:
        restored = restore_field(field.id, user, db)

    reopen.assert_called_once_with(db, LifecycleTargetType.FIELD, field.id, user.id)
    assert restored is field


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
