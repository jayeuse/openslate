"""Private Report recipe migration contract on disposable PostgreSQL."""

import json
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

SOURCE_REVISION = "c5f6d66fe368"
TARGET_REVISION = "8d2c4f1a7b90"


@pytest.mark.integration
def test_report_recipe_migration_preserves_source_schema_and_downgrades_narrowly() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    runtime_engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    inspector_engine = guarded_create_engine(environment["TEST_INSPECTOR_DATABASE_URL"])
    ids = {
        name: uuid7()
        for name in (
            "source_user",
            "report_owner",
            "audit_actor",
            "department",
            "module",
            "board",
            "dashboard",
            "report",
        )
    }

    try:
        run_alembic(environment, "downgrade", SOURCE_REVISION)
        with owner_engine.connect() as connection:
            _assert_source_head(connection, ids, seeded=False)
        _seed_source_rows(owner_engine, ids)

        run_alembic(environment, "upgrade", TARGET_REVISION)
        with owner_engine.connect() as connection:
            _assert_alembic_revision(connection, TARGET_REVISION)
            _assert_report_schema(connection)
            _assert_source_rows(connection, ids)
            _assert_report_privileges(connection)

        _assert_runtime_insert_and_inspector_read(runtime_engine, inspector_engine, ids)
        _assert_report_constraints(owner_engine, ids)

        run_alembic(environment, "downgrade", SOURCE_REVISION)
        with owner_engine.connect() as connection:
            assert connection.scalar(text("SELECT to_regclass('public.reports')")) is None
            _assert_alembic_revision(connection, SOURCE_REVISION)
            _assert_source_rows(connection, ids)
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
        member_role = connection.scalar(text("SELECT id FROM public.roles WHERE role = 'member'"))
        assert member_role is not None
        for name in ("source_user", "report_owner", "audit_actor"):
            connection.execute(
                text(
                    "INSERT INTO public.users (id, email, username, status, role_id) "
                    "VALUES (:id, :email, :username, 'active', :role_id)"
                ),
                {
                    "id": ids[name],
                    "email": f"report-{ids[name].hex}@example.test",
                    "username": f"report-{ids[name].hex}",
                    "role_id": member_role,
                },
            )
        connection.execute(
            text("INSERT INTO public.departments (id, department_name) VALUES (:id, :name)"),
            {"id": ids["department"], "name": f"Report migration {ids['department'].hex}"},
        )
        connection.execute(
            text(
                "INSERT INTO public.modules (id, department_id, module_name) "
                "VALUES (:id, :department_id, :name)"
            ),
            {
                "id": ids["module"],
                "department_id": ids["department"],
                "name": f"Report migration {ids['module'].hex}",
            },
        )
        connection.execute(
            text(
                "INSERT INTO public.boards "
                "(id, owner_id, name, status, default_section, revision) "
                "VALUES (:id, :owner_id, 'Source Board', 'active', 'overview', 3)"
            ),
            {"id": ids["board"], "owner_id": ids["source_user"]},
        )
        connection.execute(
            text(
                "INSERT INTO public.dashboards (id, owner_id, name, revision) "
                "VALUES (:id, :owner_id, 'Source Dashboard', 4)"
            ),
            {"id": ids["dashboard"], "owner_id": ids["source_user"]},
        )


def _assert_source_head(connection: Connection, ids: dict[str, UUID], *, seeded: bool) -> None:
    _assert_alembic_revision(connection, SOURCE_REVISION)
    assert connection.scalar(text("SELECT to_regclass('public.boards')")) == "boards"
    assert connection.scalar(text("SELECT to_regclass('public.dashboards')")) == "dashboards"
    if seeded:
        _assert_source_rows(connection, ids)


def _assert_alembic_revision(connection: Connection, revision: str) -> None:
    applied = connection.execute(text("SELECT version_num FROM alembic_version")).scalars().all()
    assert applied == [revision]


def _assert_source_rows(connection: Connection, ids: dict[str, UUID]) -> None:
    assert (
        connection.scalar(
            text("SELECT name FROM public.boards WHERE id = :id"), {"id": ids["board"]}
        )
        == "Source Board"
    )
    assert (
        connection.scalar(
            text("SELECT name FROM public.dashboards WHERE id = :id"),
            {"id": ids["dashboard"]},
        )
        == "Source Dashboard"
    )
    assert (
        connection.scalar(
            text("SELECT module_name FROM public.modules WHERE id = :id"),
            {"id": ids["module"]},
        )
        == f"Report migration {ids['module'].hex}"
    )


def _assert_report_schema(connection: Connection) -> None:
    columns = {
        row["column_name"]: row
        for row in connection.execute(
            text(
                "SELECT column_name, data_type, udt_name, is_nullable, column_default "
                "FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'reports'"
            )
        ).mappings()
    }
    assert columns["recipe"]["udt_name"] == "jsonb"
    assert columns["recipe"]["is_nullable"] == "NO"
    assert columns["revision"]["column_default"] == "1"
    assert columns["subtitle"]["is_nullable"] == "YES"
    assert columns["owner_id"]["is_nullable"] == "NO"
    assert columns["module_id"]["is_nullable"] == "NO"
    assert len(columns) == 12

    constraints = {
        row["conname"]: row
        for row in connection.execute(
            text(
                "SELECT conname, contype, confdeltype, "
                "pg_get_constraintdef(oid) AS definition FROM pg_constraint "
                "WHERE conrelid = 'public.reports'::regclass"
            )
        ).mappings()
    }
    expected = {
        "reports_pkey": "p",
        "ck_reports_name_nonempty": "c",
        "ck_reports_revision_positive": "c",
        "fk_reports_owner_id_users": "f",
        "fk_reports_module_id_modules": "f",
        "fk_reports_performed_by_users": "f",
    }
    assert {name: constraints[name]["contype"] for name in expected} == expected
    assert constraints["fk_reports_owner_id_users"]["confdeltype"] == "r"
    assert constraints["fk_reports_module_id_modules"]["confdeltype"] == "r"
    assert constraints["fk_reports_performed_by_users"]["confdeltype"] == "n"

    indexes = {
        row["indexname"]: row["indexdef"]
        for row in connection.execute(
            text(
                "SELECT indexname, indexdef FROM pg_indexes "
                "WHERE schemaname = 'public' AND tablename = 'reports'"
            )
        ).mappings()
    }
    assert set(indexes) == {"reports_pkey", "ix_reports_module", "ix_reports_owner_module"}
    assert "(module_id)" in indexes["ix_reports_module"]
    assert "(owner_id, module_id)" in indexes["ix_reports_owner_module"]


def _assert_report_privileges(connection: Connection) -> None:
    privileges = (
        connection.execute(
            text(
                "SELECT has_table_privilege('openslate_runtime', 'public.reports', 'SELECT') "
                "AS runtime_select, "
                "has_table_privilege('openslate_runtime', 'public.reports', 'INSERT') "
                "AS runtime_insert, "
                "has_table_privilege('openslate_runtime', 'public.reports', 'UPDATE') "
                "AS runtime_update, "
                "has_table_privilege('openslate_runtime', 'public.reports', 'DELETE') "
                "AS runtime_delete, "
                "has_table_privilege('openslate_inspector', 'public.reports', 'SELECT') "
                "AS inspector_select, "
                "has_table_privilege('openslate_inspector', 'public.reports', 'INSERT') "
                "AS inspector_insert"
            )
        )
        .mappings()
        .one()
    )
    assert all(
        privileges[f"runtime_{action}"] for action in ("select", "insert", "update", "delete")
    )
    assert privileges["inspector_select"] is True
    assert privileges["inspector_insert"] is False


def _assert_runtime_insert_and_inspector_read(
    runtime_engine: Engine, inspector_engine: Engine, ids: dict[str, UUID]
) -> None:
    with runtime_engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO public.reports (id, owner_id, module_id, name, recipe, performed_by) "
                "VALUES (:id, :owner_id, :module_id, :name, CAST(:recipe AS jsonb), :actor_id)"
            ),
            {
                "id": ids["report"],
                "owner_id": ids["report_owner"],
                "module_id": ids["module"],
                "name": "Private monthly report",
                "recipe": json.dumps({"version": 1, "fields": []}),
                "actor_id": ids["audit_actor"],
            },
        )
    with inspector_engine.connect() as connection:
        row = (
            connection.execute(
                text(
                    "SELECT owner_id, module_id, revision, recipe "
                    "FROM public.reports WHERE id = :id"
                ),
                {"id": ids["report"]},
            )
            .mappings()
            .one()
        )
    assert dict(row) == {
        "owner_id": ids["report_owner"],
        "module_id": ids["module"],
        "revision": 1,
        "recipe": {"version": 1, "fields": []},
    }


def _assert_report_constraints(engine: Engine, ids: dict[str, UUID]) -> None:
    for name, revision in (("", 1), ("Invalid revision", 0)):
        with engine.begin() as connection:
            with pytest.raises(IntegrityError):
                with connection.begin_nested():
                    connection.execute(
                        text(
                            "INSERT INTO public.reports "
                            "(id, owner_id, module_id, name, revision, recipe) "
                            "VALUES (:id, :owner_id, :module_id, :name, :revision, '{}'::jsonb)"
                        ),
                        {
                            "id": uuid7(),
                            "owner_id": ids["report_owner"],
                            "module_id": ids["module"],
                            "name": name,
                            "revision": revision,
                        },
                    )

    with engine.begin() as connection:
        with pytest.raises(IntegrityError):
            with connection.begin_nested():
                connection.execute(
                    text("DELETE FROM public.users WHERE id = :id"),
                    {"id": ids["report_owner"]},
                )
        with pytest.raises(IntegrityError):
            with connection.begin_nested():
                connection.execute(
                    text("DELETE FROM public.modules WHERE id = :id"),
                    {"id": ids["module"]},
                )
        connection.execute(
            text("DELETE FROM public.users WHERE id = :id"), {"id": ids["audit_actor"]}
        )
        assert (
            connection.scalar(
                text("SELECT performed_by FROM public.reports WHERE id = :id"),
                {"id": ids["report"]},
            )
            is None
        )


def _delete_source_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        if connection.scalar(text("SELECT to_regclass('public.reports')")) is not None:
            connection.execute(
                text("DELETE FROM public.reports WHERE id = :id"), {"id": ids["report"]}
            )
        connection.execute(text("DELETE FROM public.boards WHERE id = :id"), {"id": ids["board"]})
        connection.execute(
            text("DELETE FROM public.dashboards WHERE id = :id"), {"id": ids["dashboard"]}
        )
        connection.execute(text("DELETE FROM public.modules WHERE id = :id"), {"id": ids["module"]})
        connection.execute(
            text("DELETE FROM public.departments WHERE id = :id"),
            {"id": ids["department"]},
        )
        connection.execute(
            text("DELETE FROM public.users WHERE id = ANY(:ids)"),
            {"ids": [ids["source_user"], ids["report_owner"], ids["audit_actor"]]},
        )
