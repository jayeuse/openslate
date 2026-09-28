"""OpenView ownership catalog: no personal content, one default view per module.

The revision ``22c73bf93a9d`` removes the owner and audience columns and the three
personal tables, and refuses to run while OpenView content exists.
"""

import subprocess
from pathlib import Path
from uuid import UUID

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

REVISION = "22c73bf93a9d"
REMOVED_TABLES = ("dashboard_defaults", "saved_view_defaults", "openview_chart_preferences")


@pytest.mark.integration
def test_openview_catalog_has_no_personal_content_and_one_default_view_per_module() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    runtime_engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    ids = {key: uuid7() for key in ("department", "module", "first", "second", "archived")}
    try:
        _seed_module(owner_engine, ids)
        with owner_engine.connect() as connection:
            _assert_catalog(connection)
        _assert_one_active_default_per_module(runtime_engine, ids)
    finally:
        _delete_rows(owner_engine, ids)
        runtime_engine.dispose()
        owner_engine.dispose()


@pytest.mark.integration
def test_revision_refuses_to_downgrade_while_openview_content_exists() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    ids = {key: uuid7() for key in ("department", "module", "first", "second", "archived")}
    stepped_down = False
    try:
        _seed_module(owner_engine, ids)
        with owner_engine.begin() as connection:
            _insert_view(connection, ids["first"], ids["module"], is_default=False)

        # Later revisions step down first, so the refusal under test is this
        # revision's own guard, whatever the current head is.
        previous_revision, head = _revision_bounds()
        stepped_down = head != REVISION
        if stepped_down:
            run_alembic(environment, "downgrade", REVISION)

        with pytest.raises(subprocess.CalledProcessError):
            run_alembic(environment, "downgrade", previous_revision)

        with owner_engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM public.alembic_version")) == (
                REVISION
            )
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM public.saved_views WHERE id = :id"),
                    {"id": ids["first"]},
                )
                == 1
            )
    finally:
        _delete_rows(owner_engine, ids)
        owner_engine.dispose()
        # The seeded content is gone, so every revision can step back up.
        if stepped_down:
            run_alembic(environment, "upgrade", "head")


def _revision_bounds() -> tuple[str, str]:
    """The revision this test covers steps down to its parent; head is current."""
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parents[2] / "migrations"))
    scripts = ScriptDirectory.from_config(config)
    revision = scripts.get_revision(REVISION)
    assert revision is not None
    previous = revision.down_revision
    assert isinstance(previous, str)
    return previous, scripts.get_current_head() or REVISION


def _seed_module(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        connection.execute(
            text("INSERT INTO public.departments (id, department_name) VALUES (:id, :name)"),
            {"id": ids["department"], "name": f"OpenView {ids['department'].hex}"},
        )
        connection.execute(
            text(
                "INSERT INTO public.modules (id, department_id, module_name) "
                "VALUES (:id, :department_id, :name)"
            ),
            {
                "id": ids["module"],
                "department_id": ids["department"],
                "name": f"OpenView {ids['module'].hex}",
            },
        )


def _assert_catalog(connection: Connection) -> None:
    for table in REMOVED_TABLES:
        found = connection.scalar(text("SELECT to_regclass(:name)"), {"name": f"public.{table}"})
        assert found is None
    columns = {
        (row.table_name, row.column_name)
        for row in connection.execute(
            text(
                "SELECT table_name, column_name FROM information_schema.columns "
                "WHERE table_schema = 'public' "
                "AND table_name IN ('dashboards', 'saved_views', 'reports')"
            )
        )
    }
    assert ("dashboards", "department_id") in columns
    assert ("dashboards", "position") in columns
    assert ("saved_views", "is_default") in columns
    removed = {"owner_id", "visibility", "audience_kind", "audience_user_id"}
    assert not {column for _, column in columns} & removed

    names = [
        row.name
        for row in connection.execute(
            text(
                "SELECT conname AS name FROM pg_constraint "
                "WHERE connamespace = 'public'::regnamespace "
                "UNION ALL SELECT indexname FROM pg_indexes WHERE schemaname = 'public'"
            )
        )
    ]
    stale = [
        name
        for name in names
        if any(table.removesuffix("s") in name for table in REMOVED_TABLES)
        or (
            name.startswith(("ck_saved_views", "ix_saved_views", "ck_reports", "ix_reports"))
            and any(word in name for word in ("owner", "audience", "visibility"))
        )
        or name in {"uq_dashboards_id_owner", "ix_dashboards_owner_id"}
    ]
    assert stale == []

    default_index = connection.scalar(
        text(
            "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' "
            "AND indexname = 'uq_saved_views_module_default'"
        )
    )
    assert default_index is not None
    definition = default_index.lower()
    assert "create unique index" in definition
    assert "(module_id)" in definition
    assert "is_default" in definition and "not is_deleted" in definition


def _insert_view(
    connection: Connection,
    view_id: UUID,
    module_id: UUID,
    *,
    is_default: bool,
    is_deleted: bool = False,
) -> None:
    connection.execute(
        text(
            "INSERT INTO public.saved_views "
            "(id, module_id, name, is_default, is_deleted, definition) "
            "VALUES (:id, :module_id, :name, :is_default, :is_deleted, "
            "'{\"version\": 1}'::jsonb)"
        ),
        {
            "id": view_id,
            "module_id": module_id,
            "name": f"View {view_id.hex}",
            "is_default": is_default,
            "is_deleted": is_deleted,
        },
    )


def _assert_one_active_default_per_module(runtime_engine: Engine, ids: dict[str, UUID]) -> None:
    with runtime_engine.begin() as connection:
        _insert_view(connection, ids["first"], ids["module"], is_default=True)
        # An archived default does not count.
        _insert_view(connection, ids["archived"], ids["module"], is_default=True, is_deleted=True)
    with runtime_engine.begin() as connection:
        with pytest.raises(IntegrityError):
            with connection.begin_nested():
                _insert_view(connection, ids["second"], ids["module"], is_default=True)
        _insert_view(connection, ids["second"], ids["module"], is_default=False)


def _delete_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        connection.execute(
            text("DELETE FROM public.saved_views WHERE module_id = :id"), {"id": ids["module"]}
        )
        connection.execute(text("DELETE FROM public.modules WHERE id = :id"), {"id": ids["module"]})
        connection.execute(
            text("DELETE FROM public.departments WHERE id = :id"), {"id": ids["department"]}
        )
