import os
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import select, text
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.lifecycle.schemas import LifecycleTargetType
from app.systems.sandbox.lifecycle.service import close_lifecycle, reopen_lifecycle
from app.systems.sandbox.records.router import create_record, update_record
from app.systems.sandbox.records.schemas import RecordCreate, RecordUpdate
from tests.catalog.dynamic_field_support import (
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
pytest_plugins = ("tests.catalog.dynamic_field_support",)

def test_router_persists_jsonb_types_and_canonical_decimal_values(
    integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    field_specs = (
        ("text", FieldType.TEXT, {}),
        ("number", FieldType.NUMBER, {}),
        ("integer", FieldType.INTEGER, {}),
        ("boolean", FieldType.BOOLEAN, {}),
        ("date", FieldType.DATE, {}),
        ("datetime", FieldType.DATETIME, {}),
        ("select", FieldType.SELECT, {"options": ["open", "closed"]}),
        ("decimal", FieldType.DECIMAL, {"minimum": "0", "maximum": "20"}),
    )
    seeded = _seed_committed_module(
        owned_ids,
        fields=tuple(
            (name, field_type, position, False, config)
            for position, (name, field_type, config) in enumerate(field_specs)
        ),
    )
    _set_request(integration_db, uuid7(), "/api/fields-and-records")
    field_ids = seeded.fields
    data = {
        str(field_ids["text"]): "Title",
        str(field_ids["number"]): 2.5,
        str(field_ids["integer"]): 7,
        str(field_ids["boolean"]): True,
        str(field_ids["date"]): "2026-08-31",
        str(field_ids["datetime"]): "2026-08-31T12:34:56Z",
        str(field_ids["select"]): "open",
        str(field_ids["decimal"]): "1.2300",
    }

    record = create_record(
        RecordCreate(module_id=seeded.module_id, data=data), None, integration_db
    )
    owned_ids.add(record.id)
    assert record.data[str(field_ids["decimal"])] == "1.23"

    observed = _json_types(integration_db, record.id)
    assert {
        key: value[0]
        for key, value in observed.items()
    } == {
        str(field_ids["text"]): "string",
        str(field_ids["number"]): "number",
        str(field_ids["integer"]): "number",
        str(field_ids["boolean"]): "boolean",
        str(field_ids["date"]): "string",
        str(field_ids["datetime"]): "string",
        str(field_ids["select"]): "string",
        str(field_ids["decimal"]): "string",
    }
    assert observed[str(field_ids["decimal"])][1] == "1.23"

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

def test_record_create_rejects_module_whose_last_active_field_is_closed(
    integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    seeded = _seed_committed_module(
        owned_ids,
        fields=(("Only field", FieldType.TEXT, 0, False, {}),),
    )
    field_id = seeded.fields["Only field"]
    _set_request(integration_db, uuid7(), "/api/last-active-field-characterization")

    close_lifecycle(integration_db, LifecycleTargetType.FIELD, field_id, None)

    closed_field = integration_db.get(Field, field_id)
    assert closed_field is not None and closed_field.is_deleted is True

    with pytest.raises(HTTPException) as raised:
        create_record(
            RecordCreate(module_id=seeded.module_id, data={}),
            None,
            integration_db,
        )
    assert raised.value.status_code == 409
    assert raised.value.detail == "Module has no active fields"
    assert integration_db.connection().execute(
        text("SELECT count(*) FROM public.records WHERE module_id = :module_id"),
        {"module_id": seeded.module_id},
    ).scalar_one() == 0
