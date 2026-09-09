import os
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select, text
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.fields.models import Field, FieldType
from app.systems.fields.router import create_field, update_field
from app.systems.fields.schemas import FieldCreate, FieldUpdate
from app.systems.modules.models import Module
from app.systems.modules.router import accept_module_schema
from app.systems.records.router import create_record
from app.systems.records.schemas import RecordCreate
from tests.dynamic_field_support import (
    _database_url,
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

@pytest.mark.parametrize(
    (
        "conflict",
        "winner_name",
        "contender_name",
        "winner_position",
        "contender_position",
        "detail",
    ),
    [
        ("active name", "Winner", "Winner", 0, 1, "Field name unavailable"),
        ("active position", "Winner", "Contender", 0, 0, "Field position unavailable"),
    ],
)
def test_committed_duplicate_field_creation_returns_503_then_409_and_keeps_one_active_winner(
    conflict: str,
    winner_name: str,
    contender_name: str,
    winner_position: int,
    contender_position: int,
    detail: str,
    integration_db: AuditSession,
    owned_ids: set[UUID],
) -> None:
    seeded = _seed_committed_module(owned_ids, accepted=False)
    contender_payload = FieldCreate(
        module_id=seeded.module_id,
        name=contender_name,
        type=FieldType.TEXT,
        position=contender_position,
    )
    winner_engine = create_engine(_database_url())
    try:
        with winner_engine.connect() as winner_connection:
            winner_db = AuditSession(bind=winner_connection, expire_on_commit=False)
            _set_request(winner_db, uuid7(), f"/api/test/winner-{conflict}")
            try:
                locked_module = winner_db.scalar(
                    select(Module)
                    .where(Module.id == seeded.module_id)
                    .with_for_update()
                )
                assert locked_module is not None
                winner = Field(
                    module_id=seeded.module_id,
                    name=winner_name,
                    type=FieldType.TEXT,
                    position=winner_position,
                    config={},
                )
                winner_db.add(winner)
                winner_db.flush()
                owned_ids.add(winner.id)

                with pytest.raises(HTTPException) as held_error:
                    create_field(contender_payload, None, integration_db)
                assert held_error.value.status_code == 503

                winner_db.commit()
            finally:
                winner_db.close()
    finally:
        winner_engine.dispose()

    with pytest.raises(HTTPException) as committed_error:
        create_field(contender_payload, None, integration_db)
    assert committed_error.value.status_code == 409
    assert committed_error.value.detail == detail

    state = integration_db.connection().execute(
        text(
            """
            SELECT count(*) AS active_count,
                   count(DISTINCT name) AS active_names,
                   count(DISTINCT position) AS active_positions
            FROM public.fields
            WHERE module_id = :module_id AND is_deleted = false
            """
        ),
        {"module_id": seeded.module_id},
    ).mappings().one()
    assert dict(state) == {
        "active_count": 1,
        "active_names": 1,
        "active_positions": 1,
    }

@pytest.mark.parametrize("operation", ["record-create", "field-update"])
def test_record_create_and_field_effective_change_fail_nowait_behind_module_lock(
    operation: str,
    integration_db: AuditSession,
    owned_ids: set[UUID],
) -> None:
    seeded = _seed_committed_module(
        owned_ids,
        accepted=True,
        fields=(("Title", FieldType.TEXT, 0, False, {}),),
    )
    field_id = seeded.fields["Title"]

    with _hold_module_lock(seeded.module_id):
        with pytest.raises(HTTPException) as raised:
            if operation == "record-create":
                create_record(
                    RecordCreate(module_id=seeded.module_id, data={}),
                    None,
                    integration_db,
                )
            else:
                update_field(
                    field_id,
                    FieldUpdate(name="Renamed"),
                    None,
                    integration_db,
                )

        assert raised.value.status_code == 503
        if operation == "record-create":
            record_count = integration_db.connection().execute(
                text("SELECT count(*) FROM public.records WHERE module_id = :module_id"),
                {"module_id": seeded.module_id},
            ).scalar_one()
            assert record_count == 0
        else:
            field_state = integration_db.connection().execute(
                text(
                    """
                    SELECT name
                    FROM public.fields
                    WHERE id = :field_id
                    """
                ),
                {"field_id": field_id},
            ).mappings().one()
            assert field_state["name"] == "Title"

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
