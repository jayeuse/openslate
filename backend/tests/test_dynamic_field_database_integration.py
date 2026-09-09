import json
import os
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import Connection, create_engine, select, text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.audit.models import AuditLog
from app.systems.fields.models import FieldType
from app.systems.modules.models import Module
from app.systems.modules.router import accept_module_schema
from tests.dynamic_field_support import (
    _database_url,
    _runtime_transaction,
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
pytest_plugins = ("tests.dynamic_field_support",)

def test_direct_sql_can_store_invalid_record_data_but_postgres_rejects_invalid_field_structure(
    integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    seeded = _seed_committed_module(
        owned_ids,
        accepted=False,
        fields=(("Title", FieldType.TEXT, 0, False, {}),),
    )
    valid_field_id = seeded.fields["Title"]
    connection = integration_db.connection()

    invalid_record_id = uuid7()
    connection.execute(
        text(
            """
            INSERT INTO public.records (id, module_id, data)
            VALUES (:record_id, :module_id, CAST(:data AS jsonb))
            """
        ),
        {
            "record_id": invalid_record_id,
            "module_id": seeded.module_id,
            "data": json.dumps({str(valid_field_id): True, "unknown": {"bad": True}}),
        },
    )
    owned_ids.add(invalid_record_id)
    stored = connection.execute(
        text("SELECT data FROM public.records WHERE id = :record_id"),
        {"record_id": invalid_record_id},
    ).scalar_one()
    assert stored == {str(valid_field_id): True, "unknown": {"bad": True}}
    assert integration_db.scalars(
        select(AuditLog).where(AuditLog.entity_id == invalid_record_id)
    ).all() == []

    def insert_field(
        target_connection: Connection,
        field_id: UUID,
        name: str,
        field_type: str,
        position: int,
    ) -> None:
        target_connection.execute(
            text(
                """
                INSERT INTO public.fields
                    (id, module_id, name, type, required, position, config)
                VALUES
                    (:field_id, :module_id, :name, :field_type, false, :position, '{}'::jsonb)
                """
            ),
            {
                "field_id": field_id,
                "module_id": seeded.module_id,
                "name": name,
                "field_type": field_type,
                "position": position,
            },
        )

    structural_engine = create_engine(_database_url())
    try:
        with structural_engine.connect() as structural_connection:
            for field_id, name, field_type, position in (
                (uuid7(), "Unsupported", "unsupported", 1),
                (uuid7(), "Negative", "text", -1),
                (uuid7(), "Title", "text", 1),
                (uuid7(), "Duplicate position", "text", 0),
            ):
                with pytest.raises(IntegrityError):
                    with structural_connection.begin():
                        insert_field(
                            structural_connection,
                            field_id,
                            name,
                            field_type,
                            position,
                        )
    finally:
        structural_engine.dispose()

def test_runtime_role_can_store_invalid_record_data_without_orm_audit_and_rolls_back(
    owned_ids: set[UUID],
) -> None:
    seeded = _seed_committed_module(
        owned_ids,
        accepted=False,
        fields=(("Title", FieldType.TEXT, 0, False, {}),),
    )
    invalid_record_id = uuid7()
    owned_ids.add(invalid_record_id)
    with _runtime_transaction() as connection:
        connection.execute(
            text(
                """
                INSERT INTO public.records (id, module_id, data)
                VALUES (:record_id, :module_id, CAST(:data AS jsonb))
                """
            ),
            {
                "record_id": invalid_record_id,
                "module_id": seeded.module_id,
                "data": json.dumps(
                    {str(seeded.fields["Title"]): {"wrong": True}, "unknown": 7}
                ),
            },
        )
        assert connection.scalar(
            text("SELECT count(*) FROM public.records WHERE id = :record_id"),
            {"record_id": invalid_record_id},
        ) == 1
        assert connection.scalar(
            text("SELECT count(*) FROM public.audit_logs WHERE entity_id = :record_id"),
            {"record_id": invalid_record_id},
        ) == 0
    observer_engine = create_engine(_database_url())
    try:
        with observer_engine.connect() as observer:
            assert observer.scalar(
                text("SELECT count(*) FROM public.records WHERE id = :record_id"),
                {"record_id": invalid_record_id},
            ) == 0
            assert observer.scalar(
                text("SELECT count(*) FROM public.audit_logs WHERE entity_id = :record_id"),
                {"record_id": invalid_record_id},
            ) == 0
    finally:
        observer_engine.dispose()


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
