"""PostgreSQL support fixtures for dynamic field validation tests."""

import os
from collections.abc import Generator, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import bindparam, select, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.departments.models import Department
from app.systems.fields.models import Field, FieldType
from app.systems.modules.models import Module
from app.systems.records.models import Record
from tests.conftest import _guard_integration_database
from tests.conftest import guarded_create_engine as create_engine

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
    """Return the owner URL reserved for fixture setup and exact cleanup."""

    migration_url = os.getenv("MIGRATION_DATABASE_URL")
    if migration_url is not None and _is_owner_database(migration_url):
        return migration_url

    raise RuntimeError(
        "Dynamic field fixture setup requires an owner-capable "
        "MIGRATION_DATABASE_URL"
    )


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
    return _database_url()


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
