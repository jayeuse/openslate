"""The calendar-source migration adds one scoped table with one owner; a downgrade drops it."""

import os

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.pool import NullPool

from tests.conftest import alembic_heads, guarded_create_engine
from tests.database_pool import dispose_process_engines
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
BEFORE_SOURCES = "b7e2c4a9d1f3"
TABLE = "board_calendar_sources"


def _constraints(connection: Connection, kind: str) -> dict[str, str]:
    return dict(connection.execute(
        text("SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint "
             "WHERE conrelid = to_regclass(:table) AND contype = :kind"),
        {"table": f"public.{TABLE}", "kind": kind},
    ).tuples().all())


def test_upgrade_creates_the_scoped_source_table_and_downgrade_drops_it() -> None:
    environment = guarded_migration_environment()
    [head] = alembic_heads()
    assert head != BEFORE_SOURCES
    # No pooled fixture connection may hold locks while the schema changes.
    dispose_process_engines()
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    try:
        run_alembic(environment, "downgrade", BEFORE_SOURCES)
        with engine.connect() as connection:
            assert connection.scalar(text(f"SELECT to_regclass('public.{TABLE}')")) is None
        run_alembic(environment, "upgrade", head)
        run_alembic(environment, "check")
        with engine.connect() as connection:
            assert connection.execute(text(
                "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                "WHERE oid = to_regclass(:table)"
            ), {"table": f"public.{TABLE}"}).one() == (True, False)
            assert connection.scalars(text(
                "SELECT policyname FROM pg_policies WHERE schemaname = 'public' "
                "AND tablename = :table"
            ), {"table": TABLE}).all() == ["organization_rows"]
            checks = _constraints(connection, "c")
            assert "num_nonnulls(board_id, user_id) = 1" in checks[
                "ck_board_calendar_sources_one_owner"
            ]
            assert "ck_board_calendar_sources_position" in checks
            foreign = _constraints(connection, "f")
            assert {
                "fk_board_calendar_sources_board_id_boards",
                "fk_board_calendar_sources_module_id_modules",
                "fk_board_calendar_sources_date_field_id_fields",
                "fk_board_calendar_sources_user_id_users",
                "fk_board_calendar_sources_performed_by_users",
            } <= set(foreign)
            assert "ON DELETE RESTRICT" in foreign["fk_board_calendar_sources_date_field_id_fields"]
            assert {
                "uq_board_calendar_sources_board_field", "uq_board_calendar_sources_user_field",
            } <= set(_constraints(connection, "u"))
            assert connection.scalar(text(
                "SELECT has_table_privilege('openslate_runtime', :table, 'INSERT')"
            ), {"table": f"public.{TABLE}"})

        run_alembic(environment, "downgrade", BEFORE_SOURCES)
        with engine.connect() as connection:
            assert connection.scalar(text(f"SELECT to_regclass('public.{TABLE}')")) is None
    finally:
        run_alembic(environment, "upgrade", head)
        engine.dispose()
