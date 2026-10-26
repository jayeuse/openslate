"""Removing board widgets drops their rows and table; a downgrade recreates it empty."""

import json
import os
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool
from uuid6 import uuid7

from tests.conftest import alembic_heads, create_organization, guarded_create_engine
from tests.database_pool import dispose_process_engines
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
BEFORE_REMOVAL = "a6c970033eaa"


def test_upgrade_drops_board_widgets_and_downgrade_recreates_an_empty_table() -> None:
    environment = guarded_migration_environment()
    [head] = alembic_heads()
    assert head != BEFORE_REMOVAL
    # No pooled fixture connection may hold locks while the schema changes.
    dispose_process_engines()
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    ids: dict[str, UUID] = {}
    try:
        run_alembic(environment, "downgrade", BEFORE_REMOVAL)
        _seed_widget(engine, ids)
        run_alembic(environment, "upgrade", head)
        run_alembic(environment, "check")
        with engine.connect() as connection:
            assert _table(connection) is None
            # The Board and the Module the widget pointed at stay.
            assert connection.scalar(
                text("SELECT count(*) FROM public.boards WHERE id = :id"), {"id": ids["board"]}
            ) == 1
            assert connection.scalar(
                text("SELECT count(*) FROM public.modules WHERE id = :id"), {"id": ids["module"]}
            ) == 1

        run_alembic(environment, "downgrade", BEFORE_REMOVAL)
        with engine.connect() as connection:
            assert _table(connection) == "board_widgets"
            assert connection.scalar(text("SELECT count(*) FROM public.board_widgets")) == 0
            assert connection.execute(
                text(
                    "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                    "WHERE oid = 'public.board_widgets'::regclass"
                )
            ).one() == (True, False)
            assert connection.scalars(
                text(
                    "SELECT policyname FROM pg_policies "
                    "WHERE schemaname = 'public' AND tablename = 'board_widgets'"
                )
            ).all() == ["organization_rows"]
            constraints = dict(
                connection.execute(
                    text(
                        "SELECT conname, condeferrable FROM pg_constraint "
                        "WHERE conrelid = 'public.board_widgets'::regclass"
                    )
                ).all()
            )
            assert constraints["uq_board_widgets_board_position"] is True
            assert {
                "board_widgets_pkey",
                "uq_board_widgets_org_id_id",
                "fk_board_widgets_board_id_boards",
                "fk_board_widgets_module_id_modules",
                "fk_board_widgets_chart_id_charts",
                "ck_board_widgets_query_source",
            } <= constraints.keys()
            assert connection.scalar(
                text(
                    "SELECT has_table_privilege('openslate_runtime', "
                    "'public.board_widgets', 'INSERT')"
                )
            )
    finally:
        run_alembic(environment, "upgrade", head)
        _delete_rows(engine, ids)
        engine.dispose()


def _table(connection: Connection) -> str | None:
    value = connection.scalar(text("SELECT to_regclass('public.board_widgets')::text"))
    return None if value is None else str(value)


def _seed_widget(engine: Engine, ids: dict[str, UUID]) -> None:
    with Session(engine) as db:
        ids["org"] = create_organization(db).id
        db.commit()
    ids.update(department=uuid7(), module=uuid7(), board=uuid7(), widget=uuid7())
    with engine.begin() as connection:
        for statement in (
            "INSERT INTO public.departments (id, org_id, department_name) "
            "VALUES (:department, :org, 'Widget removal ' || :department)",
            "INSERT INTO public.modules (id, org_id, department_id, module_name) "
            "VALUES (:module, :org, :department, 'Source')",
            "INSERT INTO public.boards (id, org_id, scope, name) "
            "VALUES (:board, :org, 'project', 'Widget Board')",
            "INSERT INTO public.board_widgets (id, org_id, board_id, module_id, name, position, "
            "widget_type, config) VALUES (:widget, :org, :board, :module, 'Open work', 0, "
            "'summary', CAST(:config AS jsonb))",
        ):
            connection.execute(
                text(statement), {**ids, "config": json.dumps({"version": 1})}
            )
        assert connection.scalar(text("SELECT count(*) FROM public.board_widgets")) >= 1


def _delete_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    if "org" not in ids:
        return
    with engine.begin() as connection:
        for table in ("boards", "modules", "departments", "organizations"):
            column = "id" if table == "organizations" else "org_id"
            connection.execute(
                text(f"DELETE FROM public.{table} WHERE {column} = :org"), {"org": ids["org"]}
            )
