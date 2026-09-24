"""Board placement source-head migration on runner-owned PostgreSQL."""

from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

SOURCE_REVISION = "7d91afabd5db"
TARGET_REVISION = "4363b796c30a"
ACCESS_HEAD_REVISION = "2bf95b237416"


@pytest.mark.integration
def test_board_placement_upgrade_preserves_source_and_limits_privileges() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    runtime_engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    inspector_engine = guarded_create_engine(environment["TEST_INSPECTOR_DATABASE_URL"])
    ids = {
        name: uuid7() for name in ("owner", "department", "module", "record", "board", "placement")
    }

    try:
        run_alembic(environment, "downgrade", SOURCE_REVISION)
        _seed_source_rows(owner_engine, ids)

        run_alembic(environment, "upgrade", TARGET_REVISION)
        with owner_engine.connect() as connection:
            applied_revisions = set(
                connection.scalars(text("SELECT version_num FROM alembic_version"))
            )
            assert applied_revisions == {ACCESS_HEAD_REVISION, TARGET_REVISION}
            _assert_source_rows(connection, ids)
            _assert_placement_schema_and_privileges(connection)

        with runtime_engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO public.board_record_placements "
                    "(id, board_id, record_id, performed_by) "
                    "VALUES (:id, :board_id, :record_id, :performed_by)"
                ),
                {
                    "id": ids["placement"],
                    "board_id": ids["board"],
                    "record_id": ids["record"],
                    "performed_by": ids["owner"],
                },
            )
        with inspector_engine.connect() as connection:
            assert connection.execute(
                text(
                    "SELECT board_id, record_id, performed_by "
                    "FROM public.board_record_placements WHERE id = :id"
                ),
                {"id": ids["placement"]},
            ).one() == (ids["board"], ids["record"], ids["owner"])

        run_alembic(environment, "downgrade", SOURCE_REVISION)
        with owner_engine.connect() as connection:
            applied_revisions = set(
                connection.scalars(text("SELECT version_num FROM alembic_version"))
            )
            assert applied_revisions == {ACCESS_HEAD_REVISION, SOURCE_REVISION}
            assert (
                connection.scalar(text("SELECT to_regclass('public.board_record_placements')"))
                is None
            )
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
        role_id = connection.scalar(text("SELECT id FROM public.roles WHERE role = 'member'"))
        assert role_id is not None
        connection.execute(
            text(
                "INSERT INTO public.users (id, email, username, status, role_id) "
                "VALUES (:id, :email, :username, 'active', :role_id)"
            ),
            {
                "id": ids["owner"],
                "email": f"placement-migration-{ids['owner'].hex}@example.test",
                "username": f"placement-migration-{ids['owner'].hex}",
                "role_id": role_id,
            },
        )
        connection.execute(
            text("INSERT INTO public.departments (id, department_name) VALUES (:id, :name)"),
            {"id": ids["department"], "name": "Placement migration source"},
        )
        connection.execute(
            text(
                "INSERT INTO public.modules (id, department_id, module_name) "
                "VALUES (:id, :department_id, :name)"
            ),
            {
                "id": ids["module"],
                "department_id": ids["department"],
                "name": "Existing records",
            },
        )
        connection.execute(
            text(
                "INSERT INTO public.records (id, module_id, is_deleted) "
                "VALUES (:id, :module_id, true)"
            ),
            {"id": ids["record"], "module_id": ids["module"]},
        )
        connection.execute(
            text(
                "INSERT INTO public.boards (id, owner_id, department_id, name, status) "
                "VALUES (:id, :owner_id, :department_id, :name, 'archived')"
            ),
            {
                "id": ids["board"],
                "owner_id": ids["owner"],
                "department_id": ids["department"],
                "name": "Existing archived Board",
            },
        )


def _assert_source_rows(connection: Connection, ids: dict[str, UUID]) -> None:
    assert connection.execute(
        text("SELECT owner_id, department_id, name, status FROM public.boards WHERE id = :id"),
        {"id": ids["board"]},
    ).one() == (
        ids["owner"],
        ids["department"],
        "Existing archived Board",
        "archived",
    )
    assert connection.execute(
        text("SELECT module_id, is_deleted FROM public.records WHERE id = :id"),
        {"id": ids["record"]},
    ).one() == (ids["module"], True)


def _assert_placement_schema_and_privileges(connection: Connection) -> None:
    constraints = {
        row["conname"]: row
        for row in connection.execute(
            text(
                "SELECT conname, contype, confdeltype FROM pg_constraint "
                "WHERE conrelid = 'public.board_record_placements'::regclass"
            )
        ).mappings()
    }
    assert constraints["uq_board_record_placements_board_record"]["contype"] == "u"
    assert constraints["fk_board_record_placements_board_id_boards"]["confdeltype"] == "r"
    assert constraints["fk_board_record_placements_record_id_records"]["confdeltype"] == "r"
    assert constraints["fk_board_record_placements_performed_by_users"]["confdeltype"] == "n"
    assert (
        connection.scalar(
            text(
                "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' "
                "AND tablename = 'board_record_placements' "
                "AND indexname = 'ix_board_record_placements_record_id'"
            )
        )
        == 1
    )
    for action in ("SELECT", "INSERT", "UPDATE", "DELETE"):
        assert (
            connection.scalar(
                text(
                    "SELECT has_table_privilege('openslate_runtime', "
                    "'public.board_record_placements', :action)"
                ),
                {"action": action},
            )
            is True
        )
    assert (
        connection.scalar(
            text(
                "SELECT has_table_privilege('openslate_inspector', "
                "'public.board_record_placements', 'SELECT')"
            )
        )
        is True
    )
    for action in ("INSERT", "UPDATE", "DELETE"):
        assert (
            connection.scalar(
                text(
                    "SELECT has_table_privilege('openslate_inspector', "
                    "'public.board_record_placements', :action)"
                ),
                {"action": action},
            )
            is False
        )


def _delete_source_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        if (
            connection.scalar(text("SELECT to_regclass('public.board_record_placements')"))
            is not None
        ):
            connection.execute(
                text("DELETE FROM public.board_record_placements WHERE id = :id"),
                {"id": ids["placement"]},
            )
        for table, key in (
            ("boards", "board"),
            ("records", "record"),
            ("modules", "module"),
            ("departments", "department"),
            ("users", "owner"),
        ):
            connection.execute(
                text(f"DELETE FROM public.{table} WHERE id = :id"),
                {"id": ids[key]},
            )
