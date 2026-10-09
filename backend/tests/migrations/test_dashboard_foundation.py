"""Department Dashboard catalog contract on disposable PostgreSQL."""

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
def test_dashboard_baseline_installs_catalog_constraints_and_runtime_access() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    runtime_engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    ids = {
        "department": uuid7(),
        "dashboard": uuid7(),
        "runtime_dashboard": uuid7(),
    }

    try:
        _seed_department(owner_engine, ids)

        with owner_engine.connect() as connection:
            _assert_dashboard_schema(connection)
            _assert_dashboard_privileges(connection)

        _assert_dashboard_constraints(owner_engine, ids)
        _assert_runtime_write_and_read(runtime_engine, ids)
    finally:
        _delete_test_rows(owner_engine, ids)
        runtime_engine.dispose()
        owner_engine.dispose()


def _seed_department(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        connection.execute(
            text("INSERT INTO public.departments (id, department_name) VALUES (:id, :name)"),
            {"id": ids["department"], "name": f"Dashboard {ids['department'].hex}"},
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
        "ck_dashboards_position_nonnegative": "c",
        "ck_dashboard_widgets_type": "c",
        "ck_dashboard_widgets_position": "c",
        "fk_dashboards_department_id_departments": "f",
        "fk_dashboards_performed_by_users": "f",
        "fk_dashboard_widgets_dashboard_id_dashboards": "f",
        "fk_dashboard_widgets_performed_by_users": "f",
    }
    assert {name: constraints[name]["contype"] for name in expected_constraints} == (
        expected_constraints
    )
    assert constraints["fk_dashboards_department_id_departments"]["confdeltype"] == "r"
    assert not any("owner" in name for name in constraints)
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
    assert {"ix_dashboards_department_position", "ix_dashboard_widgets_dashboard_id"} <= set(
        indexes
    )
    assert not any("owner" in name for name in indexes)
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
    assert config_column["is_nullable"] == "YES"


def _assert_dashboard_privileges(connection: Connection) -> None:
    statement = text("SELECT has_table_privilege(:role, :table, :privilege)")
    for table in ("public.dashboards", "public.dashboard_widgets"):
        for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
            assert connection.scalar(
                statement,
                {"role": "openslate_runtime", "table": table, "privilege": privilege},
            ) is True
            for role in ("anon", "authenticated", "service_role"):
                assert (
                    connection.scalar(
                        statement,
                        {"role": role, "table": table, "privilege": privilege},
                    )
                    is False
                )


def _assert_dashboard_constraints(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        _insert_dashboard(connection, ids["dashboard"], ids["department"])

    for name, revision, position, department_id in (
        ("", 1, 0, ids["department"]),
        ("Bad revision", 0, 0, ids["department"]),
        ("Bad position", 1, -1, ids["department"]),
        ("No department", 1, 0, uuid7()),
    ):
        with engine.begin() as connection:
            with pytest.raises(IntegrityError):
                with connection.begin_nested():
                    _insert_dashboard(
                        connection,
                        uuid7(),
                        department_id,
                        name=name,
                        revision=revision,
                        position=position,
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
    department_id: UUID,
    *,
    name: str = "Migration Dashboard",
    revision: int = 1,
    position: int = 0,
) -> None:
    connection.execute(
        text(
            "INSERT INTO public.dashboards (id, department_id, name, revision, position) "
            "VALUES (:id, :department_id, :name, :revision, :position)"
        ),
        {
            "id": dashboard_id,
            "department_id": department_id,
            "name": name,
            "revision": revision,
            "position": position,
        },
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


def _assert_runtime_write_and_read(runtime_engine: Engine, ids: dict[str, UUID]) -> None:
    with runtime_engine.begin() as connection:
        _insert_dashboard(connection, ids["runtime_dashboard"], ids["department"])

    with runtime_engine.connect() as connection:
        assert (
            connection.scalar(
                text("SELECT name FROM public.dashboards WHERE id = :id"),
                {"id": ids["runtime_dashboard"]},
            )
            == "Migration Dashboard"
        )


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
        connection.execute(
            text("DELETE FROM public.departments WHERE id = :id"), {"id": ids["department"]}
        )
