import json
import os
from uuid import UUID

import pytest
from sqlalchemy import text

from app.core.database.session import AuditSession
from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.records.router import create_record
from app.systems.sandbox.records.schemas import RecordCreate
from tests.catalog.dynamic_field_support import (
    _seed_committed_module,
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


def test_migrated_explicit_null_decimal_config_is_an_unbounded_runtime_bound(
    integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    seeded = _seed_committed_module(
        owned_ids,
        fields=(("Amount", FieldType.DECIMAL, 0, False, {}),),
    )
    field_id = seeded.fields["Amount"]
    integration_db.connection().execute(
        text("UPDATE public.fields SET config = CAST(:config AS jsonb) WHERE id = :field_id"),
        {"field_id": field_id, "config": json.dumps({"minimum": None})},
    )
    integration_db.expire_all()

    config_type = integration_db.connection().execute(
        text("SELECT jsonb_typeof(config -> 'minimum') FROM public.fields WHERE id = :field_id"),
        {"field_id": field_id},
    ).scalar_one()
    assert config_type == "null"

    record = create_record(
        RecordCreate(module_id=seeded.module_id, data={str(field_id): "-12.50"}),
        None,
        integration_db,
    )
    owned_ids.add(record.id)
    assert record.data == {str(field_id): "-12.5"}
