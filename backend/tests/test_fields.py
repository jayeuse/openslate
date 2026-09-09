from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.fields.models import FieldType
from app.systems.fields.router import (
    create_field,
    reorder_module_fields,
    restore_field,
    update_field,
)
from app.systems.fields.schemas import FieldCreate, FieldReorder, FieldResponse, FieldUpdate
from app.systems.fields.validation import (
    field_config,
    validate_field_value,
    validate_module_schema,
)
from app.systems.lifecycle.exceptions import LifecycleClosedAncestorError
from app.systems.lifecycle.schemas import LifecycleTargetType
from app.systems.records.models import Record
from app.systems.records.schemas import RecordCreate
from app.systems.relationships.service import RelationshipConflict, RelationshipUnavailable
from app.systems.users.models import UserRole
from tests.field_record_support import _make_validation_client, make_field, make_module


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


def test_field_restore_checks_parent() -> None:
    module = make_module()
    deleted = make_field(module.id, deleted=True)
    db = Mock(spec=Session)
    db.get.return_value = deleted
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
