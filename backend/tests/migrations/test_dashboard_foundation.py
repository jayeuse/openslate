"""Dashboard foundation migration contract on disposable PostgreSQL."""

import json
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import IntegrityError, ProgrammingError
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

SOURCE_REVISION = "500bf45291e6"
TARGET_REVISION = "c5f6d66fe368"


@pytest.mark.integration
def test_dashboard_foundation_preserves_boards_and_downgrades_narrowly() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    runtime_engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    inspector_engine = guarded_create_engine(environment["TEST_INSPECTOR_DATABASE_URL"])
    ids = {
        "user": uuid7(),
        "board": uuid7(),
        "dashboard": uuid7(),
        "runtime_dashboard": uuid7(),
    }

    try:
        run_alembic(environment, "downgrade", SOURCE_REVISION)
        _seed_source_board(owner_engine, ids)

        run_alembic(environment, "upgrade", TARGET_REVISION)
        with owner_engine.connect() as connection:
            _assert_dashboard_schema(connection)
            _assert_existing_board(connection, ids)
            _assert_dashboard_privileges(connection)

        _assert_dashboard_constraints(owner_engine, ids)
        _assert_runtime_and_inspector_access(
            runtime_engine, inspector_engine, ids["dashboard"], ids
        )

        run_alembic(environment, "downgrade", SOURCE_REVISION)
        with owner_engine.connect() as connection:
            assert connection.scalar(text("SELECT to_regclass('public.dashboards')")) is None
            assert connection.scalar(text("SELECT to_regclass('public.dashboard_widgets')")) is None
            _assert_existing_board(connection, ids)
    finally:
        try:
            run_alembic(environment, "upgrade", "head")
        finally:
            _delete_test_rows(owner_engine, ids)
            inspector_engine.dispose()
            runtime_engine.dispose()
            owner_engine.dispose()


def _seed_source_board(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        role_id = connection.scalar(text("SELECT id FROM public.roles WHERE role = 'admin'"))
        assert role_id is not None
        connection.execute(
            text(
                "INSERT INTO public.users (id, email, username, status, role_id) "
                "VALUES (:id, :email, :username, 'active', :role_id)"
            ),
            {
                "id": ids["user"],
                "email": f"dashboard-{ids['user'].hex}@example.test",
                "username": f"dashboard-{ids['user'].hex}",
                "role_id": role_id,
            },
        )
        connection.execute(
            text(
                "INSERT INTO public.boards "
                "(id, owner_id, name, status, default_section, revision, performed_by) "
                "VALUES (:id, :owner_id, 'Before Dashboard migration', 'active', "
                "'overview', 4, :performed_by)"
            ),
            {"id": ids["board"], "owner_id": ids["user"], "performed_by": ids["user"]},
        )


def _assert_existing_board(connection: Connection, ids: dict[str, UUID]) -> None:
    board = connection.execute(
        text(
            "SELECT owner_id, name, status, default_section, revision, performed_by "
            "FROM public.boards WHERE id = :id"
        ),
        {"id": ids["board"]},
    ).one()
    assert board == (
        ids["user"],
        "Before Dashboard migration",
        "active",
        "overview",
        4,
        ids["user"],
    )


def _assert_dashboard_schema(connection: Connection) -> None:
    constraints = {
        row["conname"]: row
        for row in connection.execute(
            text(
                "SELECT conname, contype, confdeltype, "
                "pg_get_constraintdef(oid) AS definition FROM pg_constraint "
                "WHERE conrelid IN ('public.dashboards'::regclass, "
                "'public.dashboard_widgets'::regclass)"
            )
        ).mappings()
    }
    expected_constraints = {
        "ck_dashboards_name_nonempty": "c",
        "ck_dashboards_revision_positive": "c",
        "ck_dashboard_widgets_type": "c",
        "ck_dashboard_widgets_position": "c",
        "fk_dashboards_owner_id_users": "f",
        "fk_dashboards_performed_by_users": "f",
        "fk_dashboard_widgets_dashboard_id_dashboards": "f",
        "fk_dashboard_widgets_performed_by_users": "f",
    }
    assert {name: constraints[name]["contype"] for name in expected_constraints} == (
        expected_constraints
    )
    assert constraints["fk_dashboards_owner_id_users"]["confdeltype"] == "r"
    assert constraints["fk_dashboards_performed_by_users"]["confdeltype"] == "n"
    assert constraints["fk_dashboard_widgets_dashboard_id_dashboards"]["confdeltype"] == "r"
    assert constraints["fk_dashboard_widgets_performed_by_users"]["confdeltype"] == "n"
    assert (
        "FOREIGN KEY (dashboard_id) REFERENCES dashboards(id)"
        in constraints["fk_dashboard_widgets_dashboard_id_dashboards"]["definition"]
    )

    indexes = {
        row["indexname"]: row["indexdef"]
        for row in connection.execute(
            text(
                "SELECT indexname, indexdef FROM pg_indexes "
                "WHERE schemaname = 'public' AND tablename IN "
                "('dashboards', 'dashboard_widgets')"
            )
        ).mappings()
    }
    assert {"ix_dashboards_owner_id", "ix_dashboard_widgets_dashboard_id"} <= set(indexes)
    active_position = indexes["uq_dashboard_widgets_active_position"].lower().replace('"', "")
    assert "create unique index" in active_position
    assert "(dashboard_id, position)" in active_position
    assert "where" in active_position
    assert "is_deleted = false" in active_position

    config_column = (
        connection.execute(
            text(
                "SELECT data_type, udt_name, is_nullable FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'dashboard_widgets' "
                "AND column_name = 'config'"
            )
        )
        .mappings()
        .one()
    )
    assert config_column["udt_name"] == "jsonb"
    assert config_column["is_nullable"] == "NO"


def _assert_dashboard_privileges(connection: Connection) -> None:
    grants = (
        connection.execute(
            text(
                "SELECT has_table_privilege('openslate_runtime', 'public.dashboards', 'SELECT') "
                "AS runtime_select, "
                "has_table_privilege('openslate_runtime', 'public.dashboards', 'INSERT') "
                "AS runtime_insert, "
                "has_table_privilege('openslate_runtime', 'public.dashboards', 'UPDATE') "
                "AS runtime_update, "
                "has_table_privilege('openslate_runtime', 'public.dashboards', 'DELETE') "
                "AS runtime_delete, "
                "has_table_privilege('openslate_inspector', 'public.dashboards', 'SELECT') "
                "AS inspector_select, "
                "has_table_privilege('openslate_inspector', 'public.dashboards', 'INSERT') "
                "AS inspector_insert, "
                "has_table_privilege('openslate_runtime', 'public.dashboard_widgets', 'INSERT') "
                "AS widget_runtime_insert, "
                "has_table_privilege('openslate_inspector', 'public.dashboard_widgets', 'SELECT') "
                "AS widget_inspector_select"
            )
        )
        .mappings()
        .one()
    )
    assert all(
        grants[f"runtime_{operation}"] for operation in ("select", "insert", "update", "delete")
    )
    assert grants["inspector_select"] is True
    assert grants["inspector_insert"] is False
    assert grants["widget_runtime_insert"] is True
    assert grants["widget_inspector_select"] is True


def _assert_dashboard_constraints(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        _insert_dashboard(connection, ids["dashboard"], ids["user"])

    for values in (("", 1), ("Bad revision", 0)):
        with engine.begin() as connection:
            with pytest.raises(IntegrityError):
                with connection.begin_nested():
                    _insert_dashboard(
                        connection,
                        uuid7(),
                        ids["user"],
                        name=values[0],
                        revision=values[1],
                    )

    with engine.begin() as connection:
        _insert_widget(connection, uuid7(), ids["dashboard"], 0)

    for position, widget_type in ((-1, "chart"), (12, "chart"), (1, "table")):
        with engine.begin() as connection:
            with pytest.raises(IntegrityError):
                with connection.begin_nested():
                    _insert_widget(connection, uuid7(), ids["dashboard"], position, widget_type)

    with engine.begin() as connection:
        with pytest.raises(IntegrityError):
            with connection.begin_nested():
                _insert_widget(connection, uuid7(), ids["dashboard"], 0)
        _insert_widget(connection, uuid7(), ids["dashboard"], 0, is_deleted=True)
        with pytest.raises(IntegrityError):
            with connection.begin_nested():
                connection.execute(
                    text("DELETE FROM public.dashboards WHERE id = :id"),
                    {"id": ids["dashboard"]},
                )


def _insert_dashboard(
    connection: Connection,
    dashboard_id: UUID,
    owner_id: UUID,
    *,
    name: str = "Migration Dashboard",
    revision: int = 1,
) -> None:
    connection.execute(
        text(
            "INSERT INTO public.dashboards (id, owner_id, name, revision) "
            "VALUES (:id, :owner_id, :name, :revision)"
        ),
        {"id": dashboard_id, "owner_id": owner_id, "name": name, "revision": revision},
    )


def _insert_widget(
    connection: Connection,
    widget_id: UUID,
    dashboard_id: UUID,
    position: int,
    widget_type: str = "chart",
    *,
    is_deleted: bool = False,
) -> None:
    connection.execute(
        text(
            "INSERT INTO public.dashboard_widgets "
            "(id, dashboard_id, position, widget_type, config, is_deleted) "
            "VALUES (:id, :dashboard_id, :position, :widget_type, "
            "CAST(:config AS jsonb), :is_deleted)"
        ),
        {
            "id": widget_id,
            "dashboard_id": dashboard_id,
            "position": position,
            "widget_type": widget_type,
            "config": json.dumps({"version": 1, "kind": "chart"}),
            "is_deleted": is_deleted,
        },
    )


def _assert_runtime_and_inspector_access(
    runtime_engine: Engine,
    inspector_engine: Engine,
    dashboard_id: UUID,
    ids: dict[str, UUID],
) -> None:
    with runtime_engine.begin() as connection:
        _insert_dashboard(connection, ids["runtime_dashboard"], ids["user"])

    with inspector_engine.connect() as connection:
        assert (
            connection.scalar(
                text("SELECT name FROM public.dashboards WHERE id = :id"),
                {"id": dashboard_id},
            )
            == "Migration Dashboard"
        )

    with pytest.raises(ProgrammingError):
        with inspector_engine.begin() as connection:
            _insert_dashboard(connection, uuid7(), ids["user"])


def _delete_test_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                "DELETE FROM public.dashboard_widgets WHERE dashboard_id IN "
                "(:dashboard_id, :runtime_dashboard_id)"
            ),
            {
                "dashboard_id": ids["dashboard"],
                "runtime_dashboard_id": ids["runtime_dashboard"],
            },
        )
        connection.execute(
            text(
                "DELETE FROM public.dashboards WHERE id IN (:dashboard_id, :runtime_dashboard_id)"
            ),
            {
                "dashboard_id": ids["dashboard"],
                "runtime_dashboard_id": ids["runtime_dashboard"],
            },
        )
        connection.execute(text("DELETE FROM public.boards WHERE id = :id"), {"id": ids["board"]})
        connection.execute(text("DELETE FROM public.users WHERE id = :id"), {"id": ids["user"]})
