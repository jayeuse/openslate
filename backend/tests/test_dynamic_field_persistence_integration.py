import os
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import select, text
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.audit.models import AuditAction, AuditLog
from app.systems.fields.models import Field, FieldType
from app.systems.fields.router import create_field
from app.systems.fields.schemas import FieldCreate
from app.systems.lifecycle.schemas import LifecycleTargetType
from app.systems.lifecycle.service import close_lifecycle, reopen_lifecycle
from app.systems.modules.models import Module
from app.systems.modules.router import accept_module_schema
from app.systems.records.router import create_record, update_record
from app.systems.records.schemas import RecordCreate, RecordUpdate
from tests.dynamic_field_support import (
    _json_types,
    _seed_committed_module,
    _seed_committed_record,
    _set_request,
)

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]
pytest_plugins = ("tests.dynamic_field_support",)

def test_router_persists_jsonb_types_and_canonical_decimal_values(
    integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    seeded = _seed_committed_module(owned_ids, accepted=False)
    _set_request(integration_db, uuid7(), "/api/fields-and-records")
    field_specs = (
        ("text", FieldType.TEXT, {}),
        ("number", FieldType.NUMBER, {}),
        ("integer", FieldType.INTEGER, {}),
        ("boolean", FieldType.BOOLEAN, {}),
        ("date", FieldType.DATE, {}),
        ("datetime", FieldType.DATETIME, {}),
        ("select", FieldType.SELECT, {"options": ["open", "closed"]}),
        ("decimal", FieldType.DECIMAL, {"minimum": "0.00", "maximum": "20.00"}),
    )
    created_fields: dict[str, Field] = {}
    for position, (name, field_type, config) in enumerate(field_specs):
        field = create_field(
            FieldCreate(
                module_id=seeded.module_id,
                name=name,
                type=field_type,
                position=position,
                config=config,
            ),
            None,
            integration_db,
        )
        created_fields[name] = field
        owned_ids.add(field.id)

    accepted = accept_module_schema(seeded.module_id, None, integration_db)
    assert accepted.is_schema_accepted is True
    data = {
        str(created_fields["text"].id): "Title",
        str(created_fields["number"].id): 2.5,
        str(created_fields["integer"].id): 7,
        str(created_fields["boolean"].id): True,
        str(created_fields["date"].id): "2026-08-31",
        str(created_fields["datetime"].id): "2026-08-31T12:34:56Z",
        str(created_fields["select"].id): "open",
        str(created_fields["decimal"].id): "1.2300",
    }

    record = create_record(
        RecordCreate(module_id=seeded.module_id, data=data), None, integration_db
    )
    owned_ids.add(record.id)
    assert record.data[str(created_fields["decimal"].id)] == "1.23"
    assert created_fields["decimal"].config == {"minimum": "0", "maximum": "20"}

    observed = _json_types(integration_db, record.id)
    assert {
        key: value[0]
        for key, value in observed.items()
    } == {
        str(created_fields["text"].id): "string",
        str(created_fields["number"].id): "number",
        str(created_fields["integer"].id): "number",
        str(created_fields["boolean"].id): "boolean",
        str(created_fields["date"].id): "string",
        str(created_fields["datetime"].id): "string",
        str(created_fields["select"].id): "string",
        str(created_fields["decimal"].id): "string",
    }
    assert observed[str(created_fields["decimal"].id)][1] == "1.23"

    config_types = integration_db.connection().execute(
        text(
            """
            SELECT jsonb_typeof(config -> 'minimum') AS minimum_type,
                   config ->> 'minimum' AS minimum_value,
                   jsonb_typeof(config -> 'maximum') AS maximum_type,
                   config ->> 'maximum' AS maximum_value
            FROM public.fields
            WHERE id = :field_id
            """
        ),
        {"field_id": created_fields["decimal"].id},
    ).mappings().one()
    assert dict(config_types) == {
        "minimum_type": "string",
        "minimum_value": "0",
        "maximum_type": "string",
        "maximum_value": "20",
    }

    audit_rows = list(
        integration_db.scalars(
            select(AuditLog)
            .where(
                AuditLog.entity_id == record.id,
                AuditLog.action == AuditAction.CREATE,
            )
        ).all()
    )
    assert len(audit_rows) == 1
    assert audit_rows[0].after is not None
    assert audit_rows[0].after["data"] == record.data

def test_replacement_update_preserves_closed_values_drops_optional_active_values(
    integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    seeded = _seed_committed_module(
        owned_ids,
        accepted=True,
        fields=(
            ("Keep", FieldType.TEXT, 0, False, {}),
            ("Drop", FieldType.TEXT, 1, False, {}),
            ("Legacy", FieldType.TEXT, 2, False, {}),
        ),
    )
    keep_id = seeded.fields["Keep"]
    drop_id = seeded.fields["Drop"]
    legacy_id = seeded.fields["Legacy"]
    record_id = _seed_committed_record(
        owned_ids,
        seeded.module_id,
        {
            str(keep_id): "old",
            str(drop_id): "old optional",
            str(legacy_id): "legacy value",
        },
    )
    _set_request(integration_db, uuid7(), "/api/field-close-and-record-update")

    close_lifecycle(
        integration_db,
        LifecycleTargetType.FIELD,
        legacy_id,
        None,
    )
    module = integration_db.get(Module, seeded.module_id)
    assert module is not None
    assert module.is_schema_accepted is False

    closed_field = integration_db.get(Field, legacy_id)
    assert closed_field is not None and closed_field.is_deleted is True

    updated = update_record(
        record_id,
        RecordUpdate(data={str(keep_id): "new"}),
        None,
        integration_db,
    )
    assert updated.data == {
        str(keep_id): "new",
        str(legacy_id): "legacy value",
    }

    stored = integration_db.connection().execute(
        text("SELECT data FROM public.records WHERE id = :record_id"),
        {"record_id": record_id},
    ).scalar_one()
    assert stored == updated.data

    reopened = reopen_lifecycle(
        integration_db,
        LifecycleTargetType.FIELD,
        legacy_id,
        None,
    )
    assert [(row.entity_type, row.entity_id) for row in reopened.rows] == [
        ("fields", legacy_id)
    ]
    assert module.is_schema_accepted is False

@pytest.mark.parametrize("stale_acceptance", [False, True])
def test_record_create_rejects_last_active_field_closed_module(
    stale_acceptance: bool, integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    seeded = _seed_committed_module(
        owned_ids,
        accepted=True,
        fields=(("Only field", FieldType.TEXT, 0, False, {}),),
    )
    field_id = seeded.fields["Only field"]
    _set_request(integration_db, uuid7(), "/api/last-active-field-characterization")

    close_lifecycle(integration_db, LifecycleTargetType.FIELD, field_id, None)

    module = integration_db.get(Module, seeded.module_id)
    closed_field = integration_db.get(Field, field_id)
    assert module is not None and module.is_schema_accepted is False
    assert closed_field is not None and closed_field.is_deleted is True
    if stale_acceptance:
        module.is_schema_accepted = True
        integration_db.commit()

    with pytest.raises(HTTPException) as raised:
        create_record(
            RecordCreate(module_id=seeded.module_id, data={}),
            None,
            integration_db,
        )
    assert raised.value.status_code == 409
    assert raised.value.detail == "Module schema is not accepted"
    assert integration_db.connection().execute(
        text("SELECT count(*) FROM public.records WHERE module_id = :module_id"),
        {"module_id": seeded.module_id},
    ).scalar_one() == 0
