import os
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.fields.models import FieldType
from app.systems.fields.router import create_field
from app.systems.fields.schemas import FieldCreate
from app.systems.lifecycle.exceptions import LifecycleUnavailable
from app.systems.lifecycle.schemas import LifecycleTargetType
from app.systems.lifecycle.service import close_lifecycle
from app.systems.modules.router import accept_module_schema
from app.systems.records.router import create_record
from app.systems.records.schemas import RecordCreate
from tests.dynamic_field_support import (
    _hold_module_lock,
    _seed_committed_module,
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


@pytest.mark.parametrize("operation", ["schema-accept", "field-create"])
def test_schema_acceptance_and_field_create_fail_nowait_behind_module_lock(
    operation: str,
    integration_db: AuditSession,
    owned_ids: set[UUID],
) -> None:
    seeded = _seed_committed_module(
        owned_ids,
        accepted=False,
        fields=(("Existing", FieldType.TEXT, 0, False, {}),),
    )

    with _hold_module_lock(seeded.module_id):
        with pytest.raises(HTTPException) as raised:
            if operation == "schema-accept":
                accept_module_schema(seeded.module_id, None, integration_db)
            else:
                created = create_field(
                    FieldCreate(
                        module_id=seeded.module_id,
                        name="New field",
                        type=FieldType.TEXT,
                        position=1,
                    ),
                    None,
                    integration_db,
                )
                owned_ids.add(created.id)

        assert raised.value.status_code == 503
        state = integration_db.connection().execute(
            text(
                """
                SELECT is_schema_accepted,
                       (SELECT count(*) FROM public.fields
                        WHERE module_id = modules.id) AS field_count
                FROM public.modules
                WHERE id = :module_id
                """
            ),
            {"module_id": seeded.module_id},
        ).mappings().one()
        assert state["is_schema_accepted"] is False
        assert state["field_count"] == 1


def test_field_close_and_record_create_serialize_on_parent_module_lock(
    integration_db: AuditSession,
    owned_ids: set[UUID],
) -> None:
    seeded = _seed_committed_module(
        owned_ids,
        accepted=True,
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
            SELECT modules.is_schema_accepted, fields.is_deleted
            FROM public.modules
            JOIN public.fields ON fields.module_id = modules.id
            WHERE modules.id = :module_id AND fields.id = :field_id
            """
        ),
        {"module_id": seeded.module_id, "field_id": field_id},
    ).mappings().one()
    assert dict(held_state) == {"is_schema_accepted": True, "is_deleted": False}

    close_lifecycle(integration_db, LifecycleTargetType.FIELD, field_id, None)

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
