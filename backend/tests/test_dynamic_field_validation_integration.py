import json
import os
from collections.abc import Generator, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import bindparam, create_engine, select, text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import IntegrityError, ProgrammingError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.audit.models import AuditAction, AuditLog
from app.systems.departments.models import Department
from app.systems.fields.models import Field, FieldType
from app.systems.fields.router import create_field, update_field
from app.systems.fields.schemas import FieldCreate, FieldUpdate
from app.systems.lifecycle.schemas import LifecycleTargetType
from app.systems.lifecycle.service import close_lifecycle
from app.systems.modules.models import Module
from app.systems.modules.router import accept_module_schema
from app.systems.records.models import Record
from app.systems.records.router import create_record, update_record
from app.systems.records.schemas import RecordCreate, RecordUpdate
from tests.conftest import _guard_integration_database

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


@dataclass(frozen=True)
class CommittedModule:
    department_id: UUID
    module_id: UUID
    fields: dict[str, UUID]


FieldSpec = tuple[str, FieldType, int, bool, dict[str, Any]]


def _database_url() -> str:
    database_url = os.getenv("TEST_DATABASE_URL")
    if database_url is None:
        pytest.skip("Set TEST_DATABASE_URL to run PostgreSQL integration tests")
    _guard_integration_database(database_url)
    return database_url


def _set_request(db: Session, request_id: UUID, path: str = "/api/test") -> None:
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        request_id=request_id,
        request_method="POST",
        request_path=path,
    )


def _is_owner_database(database_url: str) -> bool:
    _guard_integration_database(database_url)
    engine = create_engine(database_url)
    try:
        with engine.connect() as connection:
            owns_application_tables = connection.scalar(
                text(
                    """
                    SELECT count(*) = 6
                       AND bool_and(current_user = pg_get_userbyid(c.relowner))
                    FROM pg_class AS c
                    JOIN pg_namespace AS n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public'
                      AND c.relname IN (
                          'departments', 'modules', 'fields', 'records',
                          'audit_logs', 'relationship_edges'
                      )
                    """
                )
            )
            connection.rollback()
            return owns_application_tables is True
    finally:
        engine.dispose()


def _cleanup_database_url() -> str:
    migration_url = os.getenv("MIGRATION_DATABASE_URL")
    if migration_url is not None and _is_owner_database(migration_url):
        return migration_url

    test_url = os.getenv("TEST_DATABASE_URL")
    if test_url is not None and _is_owner_database(test_url):
        return test_url

    raise RuntimeError(
        "Dynamic field cleanup requires an owner-capable MIGRATION_DATABASE_URL; "
        "TEST_DATABASE_URL is used only when it is the table owner"
    )


@pytest.fixture
def owned_ids(integration_db: Session) -> Generator[set[UUID], None, None]:
    """Remove only rows created by this test, using the owner connection."""

    ids: set[UUID] = set()
    try:
        yield ids
    finally:
        integration_db.rollback()
        integration_db.connection().rollback()
        if ids:
            database_url = _cleanup_database_url()
            engine = create_engine(database_url)
            try:
                with engine.begin() as connection:
                    is_owner = connection.scalar(
                        text(
                            """
                            SELECT current_user = pg_get_userbyid(c.relowner)
                            FROM pg_class AS c
                            JOIN pg_namespace AS n ON n.oid = c.relnamespace
                            WHERE n.nspname = 'public' AND c.relname = 'fields'
                            """
                        )
                    )
                    if is_owner is not True:
                        raise RuntimeError("Dynamic field cleanup requires table owner")

                    for table in (
                        "relationship_edges",
                        "fields",
                        "records",
                        "modules",
                        "departments",
                    ):
                        connection.execute(
                            text(f"DELETE FROM public.{table} WHERE id IN :ids").bindparams(
                                bindparam("ids", expanding=True)
                            ),
                            {"ids": list(ids)},
                        )
                    connection.execute(
                        text("DELETE FROM public.audit_logs WHERE entity_id IN :ids").bindparams(
                            bindparam("ids", expanding=True)
                        ),
                        {"ids": list(ids)},
                    )
            finally:
                engine.dispose()


def _seed_committed_module(
    owned_ids: set[UUID],
    *,
    accepted: bool,
    fields: tuple[FieldSpec, ...] = (),
) -> CommittedModule:
    """Commit a visible graph so independent PostgreSQL connections can race it."""

    engine = create_engine(_database_url())
    try:
        with engine.connect() as connection:
            db = AuditSession(bind=connection, expire_on_commit=False)
            _set_request(db, uuid7(), "/api/test/seed")
            try:
                token = str(uuid7())
                department = Department(department_name=f"Dynamic field QA {token}")
                module = Module(
                    department=department,
                    module_name=f"Dynamic module QA {token}",
                    is_schema_accepted=accepted,
                )
                field_rows = [
                    Field(
                        module=module,
                        name=name,
                        type=field_type,
                        required=required,
                        position=position,
                        config=config,
                    )
                    for name, field_type, position, required, config in fields
                ]
                db.add_all([department, module, *field_rows])
                db.flush()
                owned_ids.update(
                    {department.id, module.id, *(field.id for field in field_rows)}
                )
                db.commit()
                return CommittedModule(
                    department_id=department.id,
                    module_id=module.id,
                    fields={field.name: field.id for field in field_rows},
                )
            finally:
                db.close()
    finally:
        engine.dispose()


def _seed_committed_record(
    owned_ids: set[UUID], module_id: UUID, data: dict[str, Any]
) -> UUID:
    engine = create_engine(_database_url())
    try:
        with engine.connect() as connection:
            db = AuditSession(bind=connection, expire_on_commit=False)
            _set_request(db, uuid7(), "/api/test/seed-record")
            try:
                record = Record(module_id=module_id, data=data)
                db.add(record)
                db.flush()
                owned_ids.add(record.id)
                db.commit()
                return record.id
            finally:
                db.close()
    finally:
        engine.dispose()


@contextmanager
def _hold_module_lock(module_id: UUID) -> Iterator[None]:
    """Hold a module row lock while the application connection uses NOWAIT."""

    engine = create_engine(_database_url())
    try:
        with engine.connect() as connection:
            holder = Session(bind=connection)
            try:
                locked = holder.scalar(
                    select(Module)
                    .where(Module.id == module_id)
                    .with_for_update()
                )
                assert locked is not None
                yield
            finally:
                holder.rollback()
                holder.close()
    finally:
        engine.dispose()


@contextmanager
def _runtime_transaction() -> Iterator[Connection]:
    """Prefer an owner transaction with SET LOCAL ROLE, then use the runtime login."""

    owner_engine = create_engine(_database_url())
    owner_connection = owner_engine.connect()
    try:
        role_available = owner_connection.scalar(
            text("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openslate_runtime')")
        )
        owner_connection.rollback()
        if role_available is not True:
            pytest.skip("openslate_runtime role is unavailable in the test database")

        owner_transaction = owner_connection.begin()
        try:
            try:
                owner_connection.execute(text("SET LOCAL ROLE openslate_runtime"))
            except ProgrammingError as error:
                if getattr(error.orig, "sqlstate", None) != "42501":
                    raise
                owner_transaction.rollback()
                runtime_url = os.getenv("DATABASE_URL")
                if runtime_url is None:
                    raise RuntimeError(
                        "openslate_runtime exists but the owner cannot assume it and "
                        "DATABASE_URL is unavailable for a runtime-login check"
                    ) from error
                _guard_integration_database(runtime_url)
                owner_connection.close()
                owner_engine.dispose()
                runtime_engine = create_engine(runtime_url)
                try:
                    with runtime_engine.connect() as runtime_connection:
                        runtime_transaction = runtime_connection.begin()
                        try:
                            if runtime_connection.scalar(text("SELECT current_user")) != (
                                "openslate_runtime"
                            ):
                                raise RuntimeError(
                                    "DATABASE_URL did not connect as openslate_runtime"
                                )
                            yield runtime_connection
                        finally:
                            runtime_transaction.rollback()
                finally:
                    runtime_engine.dispose()
                return

            if owner_connection.scalar(text("SELECT current_user")) != "openslate_runtime":
                raise RuntimeError("SET LOCAL ROLE did not select openslate_runtime")
            yield owner_connection
        finally:
            if owner_transaction.is_active:
                owner_transaction.rollback()
    finally:
        owner_connection.close()
        owner_engine.dispose()


def _json_types(db: Session, record_id: UUID) -> dict[str, tuple[str, str | None]]:
    rows = db.connection().execute(
        text(
            """
            SELECT entry.key,
                   jsonb_typeof(entry.value) AS json_type,
                   entry.value #>> '{}' AS text_value
            FROM public.records AS record
            CROSS JOIN LATERAL jsonb_each(record.data) AS entry(key, value)
            WHERE record.id = :record_id
            """
        ),
        {"record_id": record_id},
    ).mappings()
    return {
        str(row["key"]): (str(row["json_type"]), row["text_value"])
        for row in rows
    }


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
    # Current lifecycle service behavior: closing a field does not invalidate
    # the module acceptance flag when the remaining active schema is valid.
    assert module.is_schema_accepted is True

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


def test_last_active_field_close_is_characterized_as_leaving_empty_record_creation_enabled(
    integration_db: AuditSession, owned_ids: set[UUID]
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
    assert module is not None and module.is_schema_accepted is True
    assert closed_field is not None and closed_field.is_deleted is True

    # Characterization only, not a desired invariant: current lifecycle code
    # leaves acceptance true after closing the last active primitive field, so
    # the record router persists an empty replacement record.
    record = create_record(
        RecordCreate(module_id=seeded.module_id, data={}),
        None,
        integration_db,
    )
    owned_ids.add(record.id)
    assert record.data == {}
    assert integration_db.connection().execute(
        text("SELECT data FROM public.records WHERE id = :record_id"),
        {"record_id": record.id},
    ).scalar_one() == {}


def test_migrated_explicit_null_decimal_config_is_a_controlled_runtime_conflict(
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

    with pytest.raises(HTTPException) as raised:
        accept_module_schema(seeded.module_id, None, integration_db)

    # Migration 0015 permits and preserves explicit JSON null bounds; current
    # runtime decimal canonicalization rejects the same persisted config.
    assert raised.value.status_code == 409
    assert raised.value.detail == (
        "Module schema is invalid: Decimal minimum must be a valid decimal string"
    )


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
