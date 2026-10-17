import os
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.lifecycle.exceptions import LifecycleUnavailable
from app.systems.sandbox.lifecycle.schemas import LifecycleTargetType
from app.systems.sandbox.lifecycle.service import close_lifecycle
from app.systems.sandbox.records.router import create_record
from app.systems.sandbox.records.schemas import RecordCreate
from tests.catalog.dynamic_field_support import (
    _hold_module_lock,
    _seed_committed_module,
    _set_request,
    record_writer,
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


def test_field_close_and_record_create_serialize_on_parent_module_lock(
    integration_db: AuditSession,
    owned_ids: set[UUID],
) -> None:
    seeded = _seed_committed_module(
        owned_ids,
        fields=(("Title", FieldType.TEXT, 0, False, {}),),
    )
    field_id = seeded.fields["Title"]
    _set_request(integration_db, uuid7(), "/api/test/field-close-and-record-create")

    with _hold_module_lock(seeded.module_id):
        with pytest.raises(LifecycleUnavailable):
            close_lifecycle(
                integration_db,
                LifecycleTargetType.FIELD,
                field_id,
                None,
            )

    held_state = integration_db.connection().execute(
        text(
            """
            SELECT fields.is_deleted
            FROM public.modules
            JOIN public.fields ON fields.module_id = modules.id
            WHERE modules.id = :module_id AND fields.id = :field_id
            """
        ),
        {"module_id": seeded.module_id, "field_id": field_id},
    ).mappings().one()
    assert dict(held_state) == {"is_deleted": False}

    close_lifecycle(integration_db, LifecycleTargetType.FIELD, field_id, None)

    with pytest.raises(HTTPException) as raised:
        create_record(
            RecordCreate(module_id=seeded.module_id, data={}),
            record_writer(integration_db, seeded.module_id),
            integration_db,
        )
    assert raised.value.status_code == 409
    assert raised.value.detail == "Module has no active fields"
    assert integration_db.connection().execute(
        text("SELECT count(*) FROM public.records WHERE module_id = :module_id"),
        {"module_id": seeded.module_id},
    ).scalar_one() == 0
