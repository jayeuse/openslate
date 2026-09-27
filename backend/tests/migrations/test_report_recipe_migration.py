"""Report recipe catalog and runtime contracts on the active Supabase baseline.

Recipe HTTP behavior is covered by ``tests/reports/test_report_routes.py``. The retired
vanilla upgrade/downgrade transition is not part of the fresh-install path.
"""

import json
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment


@pytest.mark.integration
def test_report_recipe_schema_constraints_and_runtime_access_on_active_baseline() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    runtime_engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    ids = {name: uuid7() for name in ("owner", "audit_actor", "department", "module", "report")}

    try:
        _seed_source_rows(owner_engine, ids)
        with owner_engine.connect() as connection:
            _assert_report_schema(connection)
            _assert_runtime_privileges(connection)

        _assert_runtime_insert_and_owner_read(runtime_engine, owner_engine, ids)
        _assert_report_constraints(owner_engine, ids)
    finally:
        _delete_source_rows(owner_engine, ids)
        runtime_engine.dispose()
        owner_engine.dispose()


def _seed_source_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        role_id = connection.scalar(text("SELECT id FROM public.roles WHERE role = 'member'"))
        assert role_id is not None
        for key in ("owner", "audit_actor"):
            connection.execute(
                text(
                    "INSERT INTO public.users (id, email, username, status, role_id) "
                    "VALUES (:id, :email, :username, 'active', :role_id)"
                ),
                {
                    "id": ids[key],
                    "email": f"report-baseline-{ids[key].hex}@example.test",
                    "username": f"report_baseline_{ids[key].hex}",
                    "role_id": role_id,
                },
            )
        connection.execute(
            text("INSERT INTO public.departments (id, department_name) VALUES (:id, :name)"),
            {"id": ids["department"], "name": f"Report baseline {ids['department'].hex}"},
        )
        connection.execute(
            text(
                "INSERT INTO public.modules (id, department_id, module_name) "
                "VALUES (:id, :department_id, :name)"
            ),
            {
                "id": ids["module"],
                "department_id": ids["department"],
                "name": f"Report baseline {ids['module'].hex}",
            },
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
    assert set(columns) == {
        "id",
        "created_at",
        "deleted_at",
        "is_deleted",
        "updated_at",
        "performed_by",
        "owner_id",
        "module_id",
        "name",
        "subtitle",
        "audience_kind",
        "audience_role_id",
        "audience_user_id",
        "revision",
        "recipe",
    }
    assert columns["recipe"]["udt_name"] == "jsonb"
    assert columns["recipe"]["is_nullable"] == "NO"
    assert columns["revision"]["column_default"] == "1"
    assert columns["owner_id"]["is_nullable"] == "NO"
    assert columns["module_id"]["is_nullable"] == "NO"
    assert columns["subtitle"]["is_nullable"] == "YES"
    assert columns["audience_role_id"]["is_nullable"] == "YES"
    assert columns["audience_user_id"]["is_nullable"] == "YES"

    constraints = {
        row["conname"]: row
        for row in connection.execute(
            text(
                "SELECT conname, contype, confdeltype FROM pg_constraint "
                "WHERE conrelid = 'public.reports'::regclass"
            )
        ).mappings()
    }
    expected = {
        "reports_pkey": "p",
        "ck_reports_audience": "c",
        "ck_reports_name_nonempty": "c",
        "ck_reports_revision_positive": "c",
        "fk_reports_audience_role_id_roles": "f",
        "fk_reports_audience_user_id_users": "f",
        "fk_reports_module_id_modules": "f",
        "fk_reports_owner_id_users": "f",
        "fk_reports_performed_by_users": "f",
    }
    assert {name: constraints[name]["contype"] for name in expected} == expected
    for name in (
        "fk_reports_audience_role_id_roles",
        "fk_reports_audience_user_id_users",
        "fk_reports_module_id_modules",
        "fk_reports_owner_id_users",
    ):
        assert constraints[name]["confdeltype"] == "r"
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
    assert set(indexes) == {
        "reports_pkey",
        "ix_reports_audience_role_id",
        "ix_reports_audience_user_id",
        "ix_reports_module",
        "ix_reports_owner_module",
    }
    assert "(module_id)" in indexes["ix_reports_module"]
    assert "(owner_id, module_id)" in indexes["ix_reports_owner_module"]


def _assert_runtime_privileges(connection: Connection) -> None:
    statement = text("SELECT has_table_privilege('openslate_runtime', 'public.reports', :action)")
    for action in ("SELECT", "INSERT", "UPDATE", "DELETE"):
        assert connection.scalar(statement, {"action": action}) is True


def _assert_runtime_insert_and_owner_read(
    runtime_engine: Engine, owner_engine: Engine, ids: dict[str, UUID]
) -> None:
    with runtime_engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO public.reports (id, owner_id, module_id, name, recipe, performed_by) "
                "VALUES (:id, :owner_id, :module_id, :name, CAST(:recipe AS jsonb), :actor_id)"
            ),
            {
                "id": ids["report"],
                "owner_id": ids["owner"],
                "module_id": ids["module"],
                "name": "Private monthly report",
                "recipe": json.dumps({"version": 1, "fields": []}),
                "actor_id": ids["audit_actor"],
            },
        )
    with owner_engine.connect() as connection:
        row = (
            connection.execute(
                text(
                    "SELECT owner_id, module_id, revision, recipe, audience_kind "
                    "FROM public.reports WHERE id = :id"
                ),
                {"id": ids["report"]},
            )
            .mappings()
            .one()
        )
    assert dict(row) == {
        "owner_id": ids["owner"],
        "module_id": ids["module"],
        "revision": 1,
        "recipe": {"version": 1, "fields": []},
        "audience_kind": "private",
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
                            "owner_id": ids["owner"],
                            "module_id": ids["module"],
                            "name": name,
                            "revision": revision,
                        },
                    )

    with engine.begin() as connection:
        for key in ("owner",):
            with pytest.raises(IntegrityError):
                with connection.begin_nested():
                    connection.execute(
                        text("DELETE FROM public.users WHERE id = :id"), {"id": ids[key]}
                    )
        with pytest.raises(IntegrityError):
            with connection.begin_nested():
                connection.execute(
                    text("DELETE FROM public.modules WHERE id = :id"), {"id": ids["module"]}
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
        connection.execute(text("DELETE FROM public.reports WHERE id = :id"), {"id": ids["report"]})
        connection.execute(text("DELETE FROM public.modules WHERE id = :id"), {"id": ids["module"]})
        connection.execute(
            text("DELETE FROM public.departments WHERE id = :id"), {"id": ids["department"]}
        )
        connection.execute(
            text("DELETE FROM public.users WHERE id = ANY(:ids)"),
            {"ids": [ids["owner"], ids["audit_actor"]]},
        )
