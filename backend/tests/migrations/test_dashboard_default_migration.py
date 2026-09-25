"""Dashboard default migration contract on runner-owned disposable PostgreSQL."""

from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

SOURCE_REVISION = "8d2c4f1a7b90"
TARGET_REVISION = "7d91afabd5db"
ACCESS_HEAD_REVISION = "2bf95b237416"


@pytest.mark.integration
def test_dashboard_default_migration_preserves_dashboards_and_enforces_owner() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    runtime_engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    inspector_engine = guarded_create_engine(environment["TEST_INSPECTOR_DATABASE_URL"])
    ids = {
        name: uuid7()
        for name in (
            "owner",
            "other_owner",
            "actor",
            "default_actor",
            "dashboard",
            "other_dashboard",
            "widget",
            "default",
        )
    }

    try:
        run_alembic(environment, "downgrade", SOURCE_REVISION)
        _seed_source_rows(owner_engine, ids)

        run_alembic(environment, "upgrade", TARGET_REVISION)
        with owner_engine.connect() as connection:
            _assert_alembic_revision(connection, TARGET_REVISION)
            _assert_default_schema(connection)
            _assert_source_dashboard_rows(connection, ids)
            _assert_default_privileges(connection)

        _assert_runtime_write_and_inspector_read(runtime_engine, inspector_engine, ids)
        _assert_default_constraints(owner_engine, ids)

        run_alembic(environment, "downgrade", SOURCE_REVISION)
        with owner_engine.connect() as connection:
            _assert_alembic_revision(connection, SOURCE_REVISION)
            assert (
                connection.scalar(text("SELECT to_regclass('public.dashboard_defaults')")) is None
            )
            assert (
                connection.scalar(
                    text(
                        "SELECT 1 FROM pg_constraint "
                        "WHERE conrelid = 'public.dashboards'::regclass "
                        "AND conname = 'uq_dashboards_id_owner'"
                    )
                )
                is None
            )
            _assert_source_dashboard_rows(connection, ids)
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
        role_id = connection.scalar(text("SELECT id FROM public.roles WHERE role = 'member'"))
        assert role_id is not None
        for name in ("owner", "other_owner", "actor", "default_actor"):
            user_id = ids[name]
            connection.execute(
                text(
                    "INSERT INTO public.users (id, email, username, status, role_id) "
                    "VALUES (:id, :email, :username, 'active', :role_id)"
                ),
                {
                    "id": user_id,
                    "email": f"dashboard-default-{user_id.hex}@example.test",
                    "username": f"dashboard-default-{user_id.hex}",
                    "role_id": role_id,
                },
            )
        for name, owner, label in (
            ("dashboard", "owner", "Existing Dashboard"),
            ("other_dashboard", "owner", "Another Dashboard"),
        ):
            connection.execute(
                text(
                    "INSERT INTO public.dashboards "
                    "(id, owner_id, name, revision, performed_by) "
                    "VALUES (:id, :owner_id, :name, 4, :actor)"
                ),
                {
                    "id": ids[name],
                    "owner_id": ids[owner],
                    "name": label,
                    "actor": ids["actor"],
                },
            )
        connection.execute(
            text(
                "INSERT INTO public.dashboard_widgets "
                "(id, dashboard_id, position, widget_type, config, performed_by) "
                "VALUES (:id, :dashboard_id, 2, 'chart', '{}'::jsonb, :actor)"
            ),
            {"id": ids["widget"], "dashboard_id": ids["dashboard"], "actor": ids["actor"]},
        )


def _assert_alembic_revision(connection: Connection, revision: str) -> None:
    applied = set(connection.execute(text("SELECT version_num FROM alembic_version")).scalars())
    assert applied == {ACCESS_HEAD_REVISION, revision}


def _assert_source_dashboard_rows(connection: Connection, ids: dict[str, UUID]) -> None:
    rows = connection.execute(
        text(
            "SELECT id, owner_id, name, revision, performed_by FROM public.dashboards "
            "WHERE id = ANY(:ids) ORDER BY name"
        ),
        {"ids": [ids["dashboard"], ids["other_dashboard"]]},
    ).all()
    assert rows == [
        (ids["other_dashboard"], ids["owner"], "Another Dashboard", 4, ids["actor"]),
        (ids["dashboard"], ids["owner"], "Existing Dashboard", 4, ids["actor"]),
    ]
    widget = connection.execute(
        text(
            "SELECT dashboard_id, position, widget_type, config::text, performed_by "
            "FROM public.dashboard_widgets WHERE id = :id"
        ),
        {"id": ids["widget"]},
    ).one()
    assert widget == (ids["dashboard"], 2, "chart", "{}", ids["actor"])


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
    privileges = connection.execute(
        text(
            "SELECT has_table_privilege('openslate_runtime', "
            "'public.dashboard_defaults', 'SELECT') AS runtime_select, "
            "has_table_privilege('openslate_runtime', "
            "'public.dashboard_defaults', 'INSERT') AS runtime_insert, "
            "has_table_privilege('openslate_runtime', "
            "'public.dashboard_defaults', 'UPDATE') AS runtime_update, "
            "has_table_privilege('openslate_runtime', "
            "'public.dashboard_defaults', 'DELETE') AS runtime_delete, "
            "has_table_privilege('openslate_inspector', "
            "'public.dashboard_defaults', 'SELECT') AS inspector_select, "
            "has_table_privilege('openslate_inspector', "
            "'public.dashboard_defaults', 'INSERT') AS inspector_insert, "
            "has_table_privilege('openslate_inspector', "
            "'public.dashboard_defaults', 'UPDATE') AS inspector_update, "
            "has_table_privilege('openslate_inspector', "
            "'public.dashboard_defaults', 'DELETE') AS inspector_delete"
        )
    ).mappings().one()
    assert all(
        privileges[f"runtime_{action}"] for action in ("select", "insert", "update", "delete")
    )
    assert privileges["inspector_select"] is True
    assert privileges["inspector_insert"] is False
    assert privileges["inspector_update"] is False
    assert privileges["inspector_delete"] is False


def _assert_runtime_write_and_inspector_read(
    runtime_engine: Engine, inspector_engine: Engine, ids: dict[str, UUID]
) -> None:
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
    with inspector_engine.connect() as connection:
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


def _delete_source_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        if connection.scalar(text("SELECT to_regclass('public.dashboard_defaults')")) is not None:
            connection.execute(
                text("DELETE FROM public.dashboard_defaults WHERE user_id = ANY(:users)"),
                {"users": [ids["owner"], ids["other_owner"]]},
            )
        if connection.scalar(text("SELECT to_regclass('public.dashboard_widgets')")) is not None:
            connection.execute(
                text("DELETE FROM public.dashboard_widgets WHERE dashboard_id = ANY(:ids)"),
                {"ids": [ids["dashboard"], ids["other_dashboard"]]},
            )
        if connection.scalar(text("SELECT to_regclass('public.dashboards')")) is not None:
            connection.execute(
                text("DELETE FROM public.dashboards WHERE id = ANY(:ids)"),
                {"ids": [ids["dashboard"], ids["other_dashboard"]]},
            )
        connection.execute(
            text("DELETE FROM public.users WHERE id = ANY(:ids)"),
            {
                "ids": [ids["owner"], ids["other_owner"], ids["actor"], ids["default_actor"]]
            },
        )
