"""The revision that partitions `audit_logs` keeps every row, in both directions (D4)."""

import importlib
import os
import subprocess
from collections.abc import Iterator
from dataclasses import dataclass
from uuid import UUID

import pytest
from alembic import op
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Connection, Engine, text
from sqlalchemy.pool import NullPool
from uuid6 import uuid7

from tests.conftest import alembic_heads, guarded_create_engine
from tests.database_pool import dispose_process_engines
from tests.migrations.audit_partition_support import partition_name
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration

PREVIOUS = "4d8efe5fde6f"
REVISION = importlib.import_module(
    "migrations.versions.f43c7d0ee160_audit_logs_monthly_partitions"
)
OLD_INDEXES = [
    "audit_logs_pkey",
    "ix_audit_logs_action",
    "ix_audit_logs_actor",
    "ix_audit_logs_created_at_id",
    "ix_audit_logs_department_created_at_id",
    "ix_audit_logs_entity",
    "ix_audit_logs_request",
    "uq_audit_logs_org_id_id",
]
_ROWS = text(
    "SELECT t.id, t.created_at, md5(t::text) FROM public.audit_logs AS t WHERE t.id = ANY(:ids)"
)
_CATALOG = (
    "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'audit_logs'",
    "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint "
    "WHERE conrelid = 'public.audit_logs'::regclass",
    "SELECT policyname, cmd || ' ' || roles::text || ' ' || coalesce(qual, '') || ' ' || "
    "coalesce(with_check, '') FROM pg_policies WHERE tablename = 'audit_logs'",
    "SELECT 'acl', relacl::text FROM pg_class WHERE oid = 'public.audit_logs'::regclass",
    "SELECT 'security', relrowsecurity::text || relforcerowsecurity::text FROM pg_class "
    "WHERE oid = 'public.audit_logs'::regclass",
    "SELECT attname, format_type(atttypid, atttypmod) || attnotnull::text "
    "FROM pg_attribute WHERE attrelid = 'public.audit_logs'::regclass AND attnum > 0",
)


@dataclass(frozen=True)
class _Migration:
    environment: dict[str, str]
    engine: Engine


@pytest.fixture
def migration() -> Iterator[_Migration]:
    """The test starts at the head and hands the database back at the head."""

    environment = guarded_migration_environment()
    [head] = alembic_heads()
    dispose_process_engines()
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    try:
        yield _Migration(environment, engine)
    finally:
        run_alembic(environment, "upgrade", head)
        engine.dispose()


def _plain_catalog(engine: Engine) -> list[list[tuple[str, str]]]:
    with engine.connect() as connection:
        return [sorted(connection.execute(text(query)).tuples()) for query in _CATALOG]


def _version(engine: Engine) -> str | None:
    with engine.connect() as connection:
        return connection.scalar(text("SELECT version_num FROM public.alembic_version"))


def _seed(connection: Connection) -> list[UUID]:
    """Installation rows in three months, with every kind of value that a row can hold."""

    ids = [uuid7() for _month in range(3)]
    connection.execute(
        text(
            "INSERT INTO public.audit_logs (id, created_at, action, entity_type, entity_id, "
            "department_id, before, after, request_id, request_method, request_path, "
            "actor_label, note) "
            "SELECT id, date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' "
            "  - make_interval(months => position::integer) + interval '1 day 1 hour', "
            "  'update', 'users', gen_random_uuid(), NULL, "
            "  '{\"name\": \"before\", \"nested\": {\"é\": [1, null]}}'::jsonb, "
            "  jsonb_build_object('position', position), gen_random_uuid(), 'PATCH', "
            "  '/api/users', 'Ada ''Quote'' Lovelace', NULL "
            "FROM unnest(CAST(:ids AS uuid[])) WITH ORDINALITY AS seed(id, position)"
        ),
        {"ids": ids},
    )
    return ids


def test_both_directions_keep_each_row_and_the_downgrade_rebuilds_the_plain_table(
    migration: _Migration,
) -> None:
    environment, engine = migration.environment, migration.engine
    [head] = alembic_heads()

    run_alembic(environment, "downgrade", PREVIOUS)
    downgraded = _plain_catalog(engine)
    # The old revisions, not this revision's own text, say what the downgrade must restore.
    run_alembic(environment, "downgrade", "base")
    run_alembic(environment, "upgrade", PREVIOUS)
    assert downgraded == _plain_catalog(engine)
    assert [name for name, _definition in downgraded[0]] == OLD_INDEXES

    with engine.begin() as connection:
        ids = _seed(connection)
        rows = sorted(connection.execute(_ROWS, {"ids": ids}).tuples())
    assert len(rows) == 3

    try:
        run_alembic(environment, "upgrade", head)
        with engine.connect() as connection:
            assert sorted(connection.execute(_ROWS, {"ids": ids}).tuples()) == rows
            homes = dict(
                connection.execute(
                    text(
                        "SELECT id, tableoid::regclass::text FROM public.audit_logs "
                        "WHERE id = ANY(:ids)"
                    ),
                    {"ids": ids},
                ).all()
            )
            expected = dict(
                connection.execute(
                    text(
                        "SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') "
                        "FROM public.audit_logs WHERE id = ANY(:ids)"
                    ),
                    {"ids": ids},
                ).all()
            )
        assert homes == {row_id: partition_name(day) for row_id, day in expected.items()}
        run_alembic(environment, "check")

        run_alembic(environment, "downgrade", PREVIOUS)
        with engine.connect() as connection:
            assert sorted(connection.execute(_ROWS, {"ids": ids}).tuples()) == rows
        assert _plain_catalog(engine) == downgraded
    finally:
        with engine.begin() as connection:
            connection.execute(
                text("DELETE FROM public.audit_logs WHERE id = ANY(:ids)"), {"ids": ids}
            )


def test_an_open_transaction_on_the_table_stops_the_upgrade_with_nothing_changed(
    migration: _Migration,
) -> None:
    environment, engine = migration.environment, migration.engine
    [head] = alembic_heads()
    run_alembic(environment, "downgrade", PREVIOUS)
    before = _plain_catalog(engine)

    with engine.connect() as holder:
        holder.execute(text("SELECT 1 FROM public.audit_logs LIMIT 1"))
        with pytest.raises(subprocess.CalledProcessError) as failure:
            run_alembic(environment, "upgrade", head)
        holder.rollback()

    assert "lock timeout" in failure.value.stderr
    assert _version(engine) == PREVIOUS
    assert _plain_catalog(engine) == before


@pytest.mark.parametrize(
    "keeps_the_count", [False, True], ids=["every row lost", "one row changed"]
)
def test_a_copy_that_differs_from_its_source_stops_the_move_with_nothing_changed(
    migration: _Migration, monkeypatch: pytest.MonkeyPatch, keeps_the_count: bool
) -> None:
    environment, engine = migration.environment, migration.engine
    run_alembic(environment, "downgrade", PREVIOUS)
    with engine.begin() as connection:
        ids = _seed(connection)
    before = _plain_catalog(engine)
    copy_every_row = REVISION._copy_by_day

    def damaged_copy(source: str) -> None:
        # The count alone sees a lost row; only the hash sees a changed one.
        if keeps_the_count:
            copy_every_row(source)
            op.get_bind().execute(
                text("UPDATE public.audit_logs SET note = 'changed' WHERE id = :id"),
                {"id": ids[0]},
            )

    monkeypatch.setattr(REVISION, "_copy_by_day", damaged_copy)

    try:
        with engine.connect() as connection:
            with Operations.context(MigrationContext.configure(connection)):
                with pytest.raises(RuntimeError, match="differ from the source rows"):
                    REVISION.upgrade()
            connection.rollback()

        assert _plain_catalog(engine) == before
        with engine.connect() as connection:
            assert len(connection.execute(_ROWS, {"ids": ids}).all()) == len(ids)
    finally:
        with engine.begin() as connection:
            connection.execute(
                text("DELETE FROM public.audit_logs WHERE id = ANY(:ids)"), {"ids": ids}
            )
