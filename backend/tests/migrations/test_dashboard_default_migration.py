"""Dashboard default migration contract on runner-owned disposable PostgreSQL."""

from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment


@pytest.mark.integration
def test_dashboard_default_baseline_preserves_owner_constraints_and_runtime_access() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    runtime_engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    ids = {
        name: uuid7()
        for name in (
            "owner",
            "other_owner",
            "default_actor",
            "dashboard",
            "other_dashboard",
            "default",
        )
    }

    try:
        _seed_dashboard_default_rows(owner_engine, ids)

        with owner_engine.connect() as connection:
            _assert_default_schema(connection)
            _assert_default_privileges(connection)

        _assert_runtime_write_and_read(runtime_engine, ids)
        _assert_default_constraints(owner_engine, ids)
    finally:
        _delete_dashboard_default_rows(owner_engine, ids)
        runtime_engine.dispose()
        owner_engine.dispose()


def _seed_dashboard_default_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        for name in ("owner", "other_owner", "default_actor"):
            user_id = ids[name]
            connection.execute(
                text(
                    "INSERT INTO public.users (id, email, username, status, role) "
                    "VALUES (:id, :email, :username, 'active', 'member')"
                ),
                {
                    "id": user_id,
                    "email": f"dashboard-default-{user_id.hex}@example.test",
                    "username": f"dashboard-default-{user_id.hex}",
                },
            )
        for name, owner, label in (
            ("dashboard", "owner", "Existing Dashboard"),
            ("other_dashboard", "owner", "Another Dashboard"),
        ):
            connection.execute(
                text(
                    "INSERT INTO public.dashboards (id, owner_id, name, revision) "
                    "VALUES (:id, :owner_id, :name, 4)"
                ),
                {
                    "id": ids[name],
                    "owner_id": ids[owner],
                    "name": label,
                },
            )


def _assert_default_schema(connection: Connection) -> None:
    columns = {
        row["column_name"]: row
        for row in connection.execute(
            text(
                "SELECT column_name, is_nullable, column_default "
                "FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'dashboard_defaults'"
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
        "user_id",
        "dashboard_id",
    }
    assert columns["id"]["is_nullable"] == "NO"
    assert columns["user_id"]["is_nullable"] == "NO"
    assert columns["dashboard_id"]["is_nullable"] == "NO"
    assert columns["performed_by"]["is_nullable"] == "YES"

    constraints = {
        row["conname"]: row
        for row in connection.execute(
            text(
                "SELECT conname, contype, confdeltype, pg_get_constraintdef(oid) AS definition "
                "FROM pg_constraint WHERE conrelid IN "
                "('public.dashboard_defaults'::regclass, 'public.dashboards'::regclass)"
            )
        ).mappings()
    }
    assert constraints["uq_dashboards_id_owner"]["contype"] == "u"
    assert constraints["fk_dashboard_defaults_dashboard_owner"]["confdeltype"] == "c"
    assert "(dashboard_id, user_id)" in constraints[
        "fk_dashboard_defaults_dashboard_owner"
    ]["definition"]
    assert "(id, owner_id)" in constraints["fk_dashboard_defaults_dashboard_owner"]["definition"]
    assert constraints["fk_dashboard_defaults_user_id_users"]["confdeltype"] == "c"
    assert constraints["fk_dashboard_defaults_performed_by_users"]["confdeltype"] == "n"
    assert constraints["uq_dashboard_defaults_user_id"]["contype"] == "u"

    indexes = {
        row["indexname"]: row["indexdef"]
        for row in connection.execute(
            text(
                "SELECT indexname, indexdef FROM pg_indexes "
                "WHERE schemaname = 'public' AND tablename = 'dashboard_defaults'"
            )
        ).mappings()
    }
    assert set(indexes) == {
        "dashboard_defaults_pkey",
        "uq_dashboard_defaults_user_id",
        "ix_dashboard_defaults_dashboard_id",
    }
    assert "(dashboard_id)" in indexes["ix_dashboard_defaults_dashboard_id"]


def _assert_default_privileges(connection: Connection) -> None:
    statement = text("SELECT has_table_privilege(:role, 'public.dashboard_defaults', :action)")
    for action in ("SELECT", "INSERT", "UPDATE", "DELETE"):
        assert connection.scalar(statement, {"role": "openslate_runtime", "action": action})
        for role in ("anon", "authenticated", "service_role"):
            assert (
                connection.scalar(statement, {"role": role, "action": action}) is False
            )


def _assert_runtime_write_and_read(runtime_engine: Engine, ids: dict[str, UUID]) -> None:
    with runtime_engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO public.dashboard_defaults "
                "(id, user_id, dashboard_id, performed_by) "
                "VALUES (:id, :user_id, :dashboard_id, :actor)"
            ),
            {
                "id": ids["default"],
                "user_id": ids["owner"],
                "dashboard_id": ids["dashboard"],
                "actor": ids["default_actor"],
            },
        )
    with runtime_engine.connect() as connection:
        row = connection.execute(
            text(
                "SELECT user_id, dashboard_id, performed_by, is_deleted "
                "FROM public.dashboard_defaults WHERE id = :id"
            ),
            {"id": ids["default"]},
        ).one()
    assert row == (ids["owner"], ids["dashboard"], ids["default_actor"], False)


def _assert_default_constraints(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        with pytest.raises(IntegrityError):
            with connection.begin_nested():
                connection.execute(
                    text(
                        "INSERT INTO public.dashboard_defaults (id, user_id, dashboard_id) "
                        "VALUES (:id, :user_id, :dashboard_id)"
                    ),
                    {
                        "id": uuid7(),
                        "user_id": ids["other_owner"],
                        "dashboard_id": ids["dashboard"],
                    },
                )
        with pytest.raises(IntegrityError):
            with connection.begin_nested():
                connection.execute(
                    text(
                        "INSERT INTO public.dashboard_defaults (id, user_id, dashboard_id) "
                        "VALUES (:id, :user_id, :dashboard_id)"
                    ),
                    {
                        "id": uuid7(),
                        "user_id": ids["owner"],
                        "dashboard_id": ids["other_dashboard"],
                    },
                )
        connection.execute(
            text("DELETE FROM public.users WHERE id = :id"), {"id": ids["default_actor"]}
        )
        assert (
            connection.scalar(
                text("SELECT performed_by FROM public.dashboard_defaults WHERE id = :id"),
                {"id": ids["default"]},
            )
            is None
        )


def _delete_dashboard_default_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        connection.execute(
            text("DELETE FROM public.dashboard_defaults WHERE user_id = ANY(:users)"),
            {"users": [ids["owner"], ids["other_owner"]]},
        )
        connection.execute(
            text("DELETE FROM public.dashboards WHERE id = ANY(:ids)"),
            {"ids": [ids["dashboard"], ids["other_dashboard"]]},
        )
        connection.execute(
            text("DELETE FROM public.users WHERE id = ANY(:ids)"),
            {"ids": [ids["owner"], ids["other_owner"], ids["default_actor"]]},
        )
