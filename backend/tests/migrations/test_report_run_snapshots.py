"""Report-run source-head upgrade and retention on runner-owned PostgreSQL."""

from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

SOURCE_REVISION = "4363b796c30a"
TARGET_REVISION = "587387774f96"


@pytest.mark.integration
def test_report_run_upgrade_preserves_sources_and_blocks_record_purge() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    runtime_engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    inspector_engine = guarded_create_engine(environment["TEST_INSPECTOR_DATABASE_URL"])
    ids = {
        name: uuid7()
        for name in ("owner", "department", "module", "record", "report", "run", "row")
    }

    try:
        run_alembic(environment, "downgrade", SOURCE_REVISION)
        _seed_source_rows(owner_engine, ids)

        run_alembic(environment, "upgrade", TARGET_REVISION)
        with owner_engine.connect() as connection:
            assert (
                connection.scalar(text("SELECT version_num FROM alembic_version"))
                == TARGET_REVISION
            )
            assert connection.execute(
                text("SELECT owner_id, module_id, is_deleted FROM reports WHERE id = :id"),
                {"id": ids["report"]},
            ).one() == (ids["owner"], ids["module"], True)
            for table in ("report_runs", "report_run_rows"):
                for action in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                    assert (
                        connection.scalar(
                            text(
                                "SELECT has_table_privilege('openslate_runtime', :table, :action)"
                            ),
                            {"table": f"public.{table}", "action": action},
                        )
                        is True
                    )
                assert (
                    connection.scalar(
                        text("SELECT has_table_privilege('openslate_inspector', :table, 'SELECT')"),
                        {"table": f"public.{table}"},
                    )
                    is True
                )
                for action in ("INSERT", "UPDATE", "DELETE"):
                    assert (
                        connection.scalar(
                            text(
                                "SELECT has_table_privilege('openslate_inspector', :table, :action)"
                            ),
                            {"table": f"public.{table}", "action": action},
                        )
                        is False
                    )

        with runtime_engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO report_runs "
                    "(id, report_id, module_id, idempotency_key, recipe_revision, "
                    "recipe, headings, row_count, csv_bytes) "
                    "VALUES (:id, :report, :module, :key, 1, '{}'::jsonb, "
                    "'[\"Name\"]'::jsonb, 1, :csv)"
                ),
                {
                    "id": ids["run"],
                    "report": ids["report"],
                    "module": ids["module"],
                    "key": uuid7(),
                    "csv": b"Name\r\nReady\r\n",
                },
            )
            connection.execute(
                text(
                    "INSERT INTO report_run_rows (id, run_id, position, record_id, cells) "
                    "VALUES (:id, :run, 0, :record, '[\"Ready\"]'::jsonb)"
                ),
                {"id": ids["row"], "run": ids["run"], "record": ids["record"]},
            )
        with inspector_engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT csv_bytes FROM report_runs WHERE id = :id"),
                    {"id": ids["run"]},
                ).scalar_one()
                == b"Name\r\nReady\r\n"
            )
            assert connection.execute(
                text("SELECT record_id, cells FROM report_run_rows WHERE id = :id"),
                {"id": ids["row"]},
            ).one() == (ids["record"], ["Ready"])

        with pytest.raises(IntegrityError), runtime_engine.begin() as connection:
            connection.execute(text("DELETE FROM records WHERE id = :id"), {"id": ids["record"]})
        with owner_engine.connect() as connection:
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM records WHERE id = :id"), {"id": ids["record"]}
                )
                == 1
            )

        with owner_engine.begin() as connection:
            connection.execute(
                text("DELETE FROM report_run_rows WHERE id = :id"), {"id": ids["row"]}
            )
            connection.execute(text("DELETE FROM report_runs WHERE id = :id"), {"id": ids["run"]})
        run_alembic(environment, "downgrade", SOURCE_REVISION)
        with owner_engine.connect() as connection:
            assert connection.scalar(text("SELECT to_regclass('public.report_runs')")) is None
            assert connection.scalar(text("SELECT to_regclass('public.report_run_rows')")) is None
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM reports WHERE id = :id"), {"id": ids["report"]}
                )
                == 1
            )
    finally:
        try:
            run_alembic(environment, "upgrade", "head")
        finally:
            _delete_source_rows(owner_engine, ids)
            inspector_engine.dispose()
            runtime_engine.dispose()
            owner_engine.dispose()


def _seed_source_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        role_id = connection.scalar(text("SELECT id FROM roles WHERE role = 'member'"))
        assert role_id is not None
        connection.execute(
            text(
                "INSERT INTO users (id, email, username, status, role_id) "
                "VALUES (:id, :email, :username, 'active', :role)"
            ),
            {
                "id": ids["owner"],
                "email": f"report-run-migration-{ids['owner'].hex}@example.test",
                "username": f"report-run-migration-{ids['owner'].hex}",
                "role": role_id,
            },
        )
        connection.execute(
            text("INSERT INTO departments (id, department_name) VALUES (:id, 'Report migration')"),
            {"id": ids["department"]},
        )
        connection.execute(
            text(
                "INSERT INTO modules (id, department_id, module_name) "
                "VALUES (:id, :department, 'Report source')"
            ),
            {"id": ids["module"], "department": ids["department"]},
        )
        connection.execute(
            text("INSERT INTO records (id, module_id, is_deleted) VALUES (:id, :module, true)"),
            {"id": ids["record"], "module": ids["module"]},
        )
        connection.execute(
            text(
                "INSERT INTO reports (id, owner_id, module_id, name, recipe, is_deleted) "
                "VALUES (:id, :owner, :module, 'Archived Report', '{}'::jsonb, true)"
            ),
            {"id": ids["report"], "owner": ids["owner"], "module": ids["module"]},
        )


def _delete_source_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        if connection.scalar(text("SELECT to_regclass('public.report_run_rows')")) is not None:
            connection.execute(
                text("DELETE FROM report_run_rows WHERE id = :id"), {"id": ids["row"]}
            )
            connection.execute(text("DELETE FROM report_runs WHERE id = :id"), {"id": ids["run"]})
        for table, key in (
            ("reports", "report"),
            ("records", "record"),
            ("modules", "module"),
            ("departments", "department"),
            ("users", "owner"),
        ):
            connection.execute(text(f"DELETE FROM {table} WHERE id = :id"), {"id": ids[key]})
