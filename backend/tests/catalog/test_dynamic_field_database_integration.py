import json
import os
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import text

from app.core.database.session import AuditSession
from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.modules.router import accept_module_schema
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


def test_migrated_explicit_null_decimal_config_is_accepted_as_an_unbounded_runtime_bound(
    integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    seeded = _seed_committed_module(
        owned_ids,
        accepted=False,
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

    accepted = accept_module_schema(seeded.module_id, None, integration_db)
    assert accepted.is_schema_accepted is True


def test_malformed_db_permitted_config_returns_controlled_schema_acceptance_conflict(
    integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    seeded = _seed_committed_module(
        owned_ids,
        accepted=False,
        fields=(("Title", FieldType.TEXT, 0, False, {}),),
    )
    field_id = seeded.fields["Title"]
    integration_db.connection().execute(
        text("UPDATE public.fields SET config = CAST(:config AS jsonb) WHERE id = :field_id"),
        {
            "field_id": field_id,
            "config": json.dumps({"minLength": "not-an-integer"}),
        },
    )
    integration_db.expire_all()

    with pytest.raises(HTTPException) as raised:
        accept_module_schema(seeded.module_id, None, integration_db)

    assert raised.value.status_code == 409
    assert raised.value.detail == (
        "Module schema is invalid: "
        "Text field minLength must be a nonnegative integer"
    )
    module = integration_db.get(Module, seeded.module_id)
    assert module is not None and module.is_schema_accepted is False
