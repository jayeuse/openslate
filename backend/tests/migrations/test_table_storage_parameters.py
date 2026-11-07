"""Per-table storage parameters, which `alembic check` does not compare (F12, F18)."""

import os
from collections.abc import Iterator

import pytest
from sqlalchemy import Connection, Engine, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from tests.conftest import alembic_heads, guarded_create_engine
from tests.database_pool import dispose_process_engines
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration

PREVIOUS = "cf8cb7605f48"
QUEUE_TABLE = {
    "autovacuum_vacuum_scale_factor": "0.02",
    "autovacuum_analyze_scale_factor": "0.01",
    "autovacuum_vacuum_insert_scale_factor": "0.02",
}
UPDATED_TABLE = {
    "autovacuum_vacuum_scale_factor": "0.02",
    "autovacuum_analyze_scale_factor": "0.01",
}
EXPECTED = {
    "record_trigger_events": QUEUE_TABLE,
    "in_app_notifications": QUEUE_TABLE,
    "relationship_edges": UPDATED_TABLE,
    "records": {**UPDATED_TABLE, "fillfactor": "90"},
}


def _storage_parameters(connection: Connection) -> dict[str, dict[str, str]]:
    rows = connection.execute(
        text(
            "SELECT c.relname, c.reloptions FROM pg_class AS c "
            "JOIN pg_namespace AS n ON n.oid = c.relnamespace "
            "WHERE n.nspname = 'public' AND c.relname = ANY(:tables)"
        ),
        {"tables": sorted(EXPECTED)},
    )
    return {
        name: dict(option.split("=", 1) for option in options or [])
        for name, options in rows
    }


def test_each_table_has_its_storage_parameters(integration_owner_db: Session) -> None:
    assert _storage_parameters(integration_owner_db.connection()) == EXPECTED


def test_each_audit_partition_has_its_own_storage_parameters(
    integration_owner_db: Session,
) -> None:
    # A partitioned parent holds no storage parameters, and a partition inherits none.
    rows = integration_owner_db.connection().execute(
        text(
            "SELECT child.relname, child.reloptions FROM pg_inherits AS link "
            "JOIN pg_class AS child ON child.oid = link.inhrelid "
            "WHERE link.inhparent = 'public.audit_logs'::regclass"
        )
    )
    leaves = {
        name: dict(option.split("=", 1) for option in options or []) for name, options in rows
    }
    assert "audit_logs_default" in leaves
    assert leaves == dict.fromkeys(leaves, QUEUE_TABLE)


@pytest.fixture
def migration() -> Iterator[tuple[dict[str, str], Engine]]:
    """The test starts at the head and hands the database back at the head."""
    environment = guarded_migration_environment()
    [head] = alembic_heads()
    dispose_process_engines()
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    try:
        yield environment, engine
    finally:
        run_alembic(environment, "upgrade", head)
        engine.dispose()


def test_downgrade_resets_the_parameters_and_upgrade_restores_them(
    migration: tuple[dict[str, str], Engine],
) -> None:
    environment, engine = migration
    [head] = alembic_heads()

    run_alembic(environment, "downgrade", PREVIOUS)
    with engine.connect() as connection:
        assert _storage_parameters(connection) == dict.fromkeys(EXPECTED, {})

    run_alembic(environment, "upgrade", head)
    with engine.connect() as connection:
        assert _storage_parameters(connection) == EXPECTED
    run_alembic(environment, "check")
