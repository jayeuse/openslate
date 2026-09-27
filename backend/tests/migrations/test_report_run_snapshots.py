"""Report-run catalog and runtime contracts on the active Supabase baseline.

Snapshot and purge behavior is exercised through ``tests/reports/test_report_run_routes.py``.
This test protects the current PostgreSQL constraints and runtime write path without replaying
retired vanilla migration transitions.
"""

from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment


@pytest.mark.integration
def test_report_run_catalog_constraints_and_runtime_access_on_active_baseline() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    runtime_engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    ids = {
        name: uuid7()
        for name in ("owner", "department", "module", "record", "report", "run", "row")
    }

    try:
        _seed_source_rows(owner_engine, ids)
        with owner_engine.connect() as connection:
            _assert_report_run_schema(connection)
            _assert_runtime_privileges(connection)

        _assert_runtime_write_and_owner_read(runtime_engine, owner_engine, ids)
        _assert_record_delete_is_restricted(runtime_engine, owner_engine, ids)
    finally:
        _delete_source_rows(owner_engine, ids)
        runtime_engine.dispose()
        owner_engine.dispose()


def _seed_source_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO public.users (id, email, username, status, role) "
                "VALUES (:id, :email, :username, 'active', 'member')"
            ),
            {
                "id": ids["owner"],
                "email": f"report-run-baseline-{ids['owner'].hex}@example.test",
                "username": f"report_run_baseline_{ids['owner'].hex}",
            },
        )
        connection.execute(
            text("INSERT INTO public.departments (id, department_name) VALUES (:id, :name)"),
            {"id": ids["department"], "name": f"Report run {ids['department'].hex}"},
        )
        connection.execute(
            text(
                "INSERT INTO public.modules (id, department_id, module_name) "
                "VALUES (:id, :department_id, :name)"
            ),
            {
                "id": ids["module"],
                "department_id": ids["department"],
                "name": f"Report run {ids['module'].hex}",
            },
        )
        connection.execute(
            text("INSERT INTO public.records (id, module_id) VALUES (:id, :module_id)"),
            {"id": ids["record"], "module_id": ids["module"]},
        )
        connection.execute(
            text(
                "INSERT INTO public.reports "
                "(id, owner_id, module_id, name, recipe, is_deleted) "
                "VALUES (:id, :owner_id, :module_id, 'Archived report', '{}'::jsonb, true)"
            ),
            {"id": ids["report"], "owner_id": ids["owner"], "module_id": ids["module"]},
        )


def _assert_report_run_schema(connection: Connection) -> None:
    columns: dict[str, dict[str, dict[str, str]]] = {
        "report_runs": {},
        "report_run_rows": {},
    }
    for row in connection.execute(
        text(
            "SELECT table_name, column_name, udt_name, is_nullable "
            "FROM information_schema.columns "
            "WHERE table_schema = 'public' "
            "AND table_name IN ('report_runs', 'report_run_rows')"
        )
    ).mappings():
        columns[row["table_name"]][row["column_name"]] = row
    assert set(columns) == {"report_runs", "report_run_rows"}
    assert columns["report_runs"]["recipe"]["udt_name"] == "jsonb"
    assert columns["report_runs"]["headings"]["udt_name"] == "jsonb"
    assert columns["report_runs"]["csv_bytes"]["udt_name"] == "bytea"
    assert columns["report_run_rows"]["cells"]["udt_name"] == "jsonb"
    assert columns["report_run_rows"]["position"]["udt_name"] == "int4"
    assert columns["report_runs"]["report_id"]["is_nullable"] == "NO"
    assert columns["report_run_rows"]["record_id"]["is_nullable"] == "NO"

    constraints = {
        row["conname"]: row
        for row in connection.execute(
            text(
                "SELECT conname, contype, confdeltype FROM pg_constraint "
                "WHERE conrelid IN "
                "('public.report_runs'::regclass, 'public.report_run_rows'::regclass)"
            )
        ).mappings()
    }
    expected = {
        "report_runs_pkey": "p",
        "ck_report_runs_recipe_revision_positive": "c",
        "ck_report_runs_row_count_nonnegative": "c",
        "fk_report_runs_module_id_modules": "f",
        "fk_report_runs_performed_by_users": "f",
        "fk_report_runs_report_id_reports": "f",
        "uq_report_runs_idempotency": "u",
        "report_run_rows_pkey": "p",
        "ck_report_run_rows_position_nonnegative": "c",
        "fk_report_run_rows_performed_by_users": "f",
        "fk_report_run_rows_record_id_records": "f",
        "fk_report_run_rows_run_id_report_runs": "f",
        "uq_report_run_rows_position": "u",
        "uq_report_run_rows_record": "u",
    }
    assert {name: constraints[name]["contype"] for name in expected} == expected
    for name in (
        "fk_report_runs_module_id_modules",
        "fk_report_runs_report_id_reports",
        "fk_report_run_rows_record_id_records",
        "fk_report_run_rows_run_id_report_runs",
    ):
        assert constraints[name]["confdeltype"] == "r"
    for name in ("fk_report_runs_performed_by_users", "fk_report_run_rows_performed_by_users"):
        assert constraints[name]["confdeltype"] == "n"

    indexes = {
        row["indexname"]
        for row in connection.execute(
            text(
                "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' "
                "AND tablename IN ('report_runs', 'report_run_rows')"
            )
        ).mappings()
    }
    assert indexes == {
        "report_runs_pkey",
        "uq_report_runs_idempotency",
        "ix_report_runs_module",
        "ix_report_runs_report_created",
        "report_run_rows_pkey",
        "uq_report_run_rows_position",
        "uq_report_run_rows_record",
        "ix_report_run_rows_record",
    }


def _assert_runtime_privileges(connection: Connection) -> None:
    statement = text("SELECT has_table_privilege('openslate_runtime', :table, :action)")
    for table in ("public.report_runs", "public.report_run_rows"):
        for action in ("SELECT", "INSERT", "UPDATE", "DELETE"):
            assert connection.scalar(statement, {"table": table, "action": action}) is True


def _assert_runtime_write_and_owner_read(
    runtime_engine: Engine, owner_engine: Engine, ids: dict[str, UUID]
) -> None:
    with runtime_engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO public.report_runs "
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
                "INSERT INTO public.report_run_rows "
                "(id, run_id, position, record_id, cells) "
                "VALUES (:id, :run, 0, :record, '[\"Ready\"]'::jsonb)"
            ),
            {"id": ids["row"], "run": ids["run"], "record": ids["record"]},
        )
    with owner_engine.connect() as connection:
        assert (
            connection.scalar(
                text("SELECT csv_bytes FROM public.report_runs WHERE id = :id"),
                {"id": ids["run"]},
            )
            == b"Name\r\nReady\r\n"
        )
        assert connection.execute(
            text("SELECT record_id, cells FROM public.report_run_rows WHERE id = :id"),
            {"id": ids["row"]},
        ).one() == (ids["record"], ["Ready"])


def _assert_record_delete_is_restricted(
    runtime_engine: Engine, owner_engine: Engine, ids: dict[str, UUID]
) -> None:
    with pytest.raises(IntegrityError), runtime_engine.begin() as connection:
        connection.execute(text("DELETE FROM public.records WHERE id = :id"), {"id": ids["record"]})
    with owner_engine.connect() as connection:
        assert (
            connection.scalar(
                text("SELECT count(*) FROM public.records WHERE id = :id"),
                {"id": ids["record"]},
            )
            == 1
        )


def _delete_source_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        connection.execute(
            text("DELETE FROM public.report_run_rows WHERE id = :id"), {"id": ids["row"]}
        )
        connection.execute(
            text("DELETE FROM public.report_runs WHERE id = :id"), {"id": ids["run"]}
        )
        connection.execute(text("DELETE FROM public.reports WHERE id = :id"), {"id": ids["report"]})
        connection.execute(text("DELETE FROM public.records WHERE id = :id"), {"id": ids["record"]})
        connection.execute(text("DELETE FROM public.modules WHERE id = :id"), {"id": ids["module"]})
        connection.execute(
            text("DELETE FROM public.departments WHERE id = :id"), {"id": ids["department"]}
        )
        connection.execute(text("DELETE FROM public.users WHERE id = :id"), {"id": ids["owner"]})
