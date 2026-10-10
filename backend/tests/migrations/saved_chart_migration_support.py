"""Owned disposable fixtures for the saved-chart migration, without source-schema imports."""

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.pool import NullPool
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.database_pool import dispose_pooled_engines
from tests.operations.migration_support import guarded_migration_environment, run_alembic

HEAD = "c64062dacada"
PREDECESSOR = "5d4e4a094aa7"
STAMP = datetime(2025, 2, 3, 4, 5, 6, tzinfo=UTC)


def literal_query():
    return {
        "version": 1,
        "fields": [{"field_id": "11111111-1111-4111-8111-111111111111", "expected_type": "text"}],
        "filters": [
            {
                "field_id": "11111111-1111-4111-8111-111111111111",
                "expected_type": "text",
                "operator": "contains",
                "value": "Literal & Unicode \u03bb",
            }
        ],
        "logic": "or",
        "metric": {"field_id": "22222222-2222-4222-8222-222222222222", "expected_type": "decimal"},
        "visualization": "bar",
    }


@dataclass(repr=False)
class ChartMigrationFixture:
    environment: dict[str, str]
    owner: Engine
    runtime: Engine
    ids: dict[str, UUID]

    def revision(self) -> str:
        with self.owner.connect() as connection:
            return str(connection.scalar(text("SELECT version_num FROM public.alembic_version")))

    def record_lineage(self, stdout: str, stderr: str) -> None:
        directory = Path(__file__).parents[2] / "test-results" / "migrations"
        directory /= "s26-" + self.environment["OPENSLATE_FULLSTACK_RUN_ID"]
        directory.mkdir(parents=True, exist_ok=True)
        safe_lines = [
            line
            for line in (stdout + stderr).splitlines()
            if "Running upgrade " in line
            or "Running downgrade " in line
            or line.startswith("Saved chart ")
        ]
        (directory / f"backfill-{uuid7().hex}.log").write_text("\n".join(safe_lines) + "\n")

    def require_sole_consumer(self) -> None:
        # Idle connections that earlier tests left in this process's shared pools are
        # closed first; any other consumer still fails the check below.
        dispose_pooled_engines()
        with self.owner.connect() as connection:
            assert connection.scalar(text("SELECT current_setting('cluster_name')")) == (
                "openslate-e2e-" + self.environment["OPENSLATE_FULLSTACK_RUN_ID"]
            )
            assert (
                connection.scalar(
                    text("""
                    SELECT count(*) FROM pg_stat_activity
                    WHERE datname = current_database() AND pid <> pg_backend_pid()
                      AND usename IN ('openslate_owner', 'openslate_runtime')
                """)
                )
                == 0
            ), "Migration rewind requires the sole guarded consumer"

    def rewind(self) -> None:
        self.require_sole_consumer()
        run_alembic(self.environment, "downgrade", PREDECESSOR)
        assert self.revision() == PREDECESSOR

    def upgrade(self) -> None:
        run_alembic(self.environment, "upgrade", HEAD)
        assert self.revision() == HEAD

    def snapshots(self, table: str) -> list[dict[str, object]]:
        assert table in {"board_widgets", "dashboard_widgets"}
        parent = "board_id" if table == "board_widgets" else "dashboard_id"
        parent_id = self.ids["board" if table == "board_widgets" else "dashboard"]
        with self.owner.connect() as connection:
            return [
                dict(row)
                for row in connection.execute(
                    text(
                        f"SELECT * FROM public.{table} WHERE {parent} = :parent ORDER BY position"
                    ),
                    {"parent": parent_id},
                ).mappings()
            ]

    def seed_legacy(self, configs: list[object]) -> None:
        with self.owner.begin() as connection:
            for position, config in enumerate(configs):
                connection.execute(
                    text("""
                        INSERT INTO public.board_widgets
                            (id, board_id, module_id, name, position, widget_type, config,
                             created_at, updated_at, is_deleted, deleted_at, performed_by)
                        VALUES (:id, :board, :module, :name, :position, 'summary',
                                CAST(:config AS jsonb), :stamp, :stamp, :archived,
                                :deleted, :actor)
                    """),
                    {
                        "id": uuid7(),
                        "board": self.ids["board"],
                        "module": self.ids["module"],
                        "name": f"Literal widget {position}",
                        "position": position,
                        "config": json.dumps(config),
                        "stamp": STAMP,
                        "archived": position == 3,
                        "deleted": STAMP if position == 3 else None,
                        "actor": self.ids["actor"],
                    },
                )
            connection.execute(
                text("""
                    INSERT INTO public.dashboard_widgets
                        (id, dashboard_id, position, widget_type, config, created_at, updated_at)
                    VALUES (:id, :dashboard, 0, 'summary', CAST(:config AS jsonb), :stamp, :stamp)
                """),
                {
                    "id": uuid7(),
                    "dashboard": self.ids["dashboard"],
                    "stamp": STAMP,
                    "config": json.dumps(
                        {
                            "version": 1,
                            "query": {
                                "module_id": str(self.ids["module"]),
                                "definition": {"columns": [], "filters": []},
                            },
                        }
                    ),
                },
            )

    def clear_widgets(self) -> None:
        with self.owner.begin() as connection:
            connection.execute(
                text("DELETE FROM public.board_widgets WHERE board_id = :id"),
                {"id": self.ids["board"]},
            )
            connection.execute(
                text("DELETE FROM public.dashboard_widgets WHERE dashboard_id = :id"),
                {"id": self.ids["dashboard"]},
            )

    def clean(self) -> None:
        self.clear_widgets()
        with self.owner.begin() as connection:
            if connection.scalar(text("SELECT to_regclass('public.charts')")) is not None:
                connection.execute(
                    text("DELETE FROM public.charts WHERE module_id = :id"),
                    {"id": self.ids["module"]},
                )
            connection.execute(
                text("DELETE FROM public.dashboards WHERE id = :id"), {"id": self.ids["dashboard"]}
            )
            connection.execute(
                text("DELETE FROM public.boards WHERE id = :id"), {"id": self.ids["board"]}
            )
            connection.execute(
                text("DELETE FROM public.modules WHERE id = :id"), {"id": self.ids["module"]}
            )
            connection.execute(
                text("DELETE FROM public.departments WHERE id = :id"),
                {"id": self.ids["department"]},
            )
            connection.execute(
                text("DELETE FROM public.users WHERE id = :id"), {"id": self.ids["actor"]}
            )


@pytest.fixture
def chart_migration():
    environment = guarded_migration_environment()
    fixture = ChartMigrationFixture(
        environment,
        guarded_create_engine(environment["MIGRATION_DATABASE_URL"], poolclass=NullPool),
        guarded_create_engine(environment["TEST_DATABASE_URL"], poolclass=NullPool),
        {key: uuid7() for key in ("actor", "department", "module", "board", "dashboard", "chart")},
    )
    try:
        assert fixture.revision() == HEAD
        with fixture.owner.begin() as connection:
            connection.execute(
                text("""INSERT INTO public.users (id, email, username, status, role)
                        VALUES (:id, :email, :username, 'active', 'member')"""),
                {
                    "id": fixture.ids["actor"],
                    "email": f"{fixture.ids['actor'].hex}@example.test",
                    "username": "s26_" + fixture.ids["actor"].hex,
                },
            )
            connection.execute(
                text("INSERT INTO public.departments (id, department_name) VALUES (:id, :name)"),
                {"id": fixture.ids["department"], "name": "S26 " + fixture.ids["department"].hex},
            )
            connection.execute(
                text(
                    "INSERT INTO public.modules (id, department_id, module_name) "
                    "VALUES (:id, :department, 'Source')"
                ),
                {"id": fixture.ids["module"], "department": fixture.ids["department"]},
            )
            connection.execute(
                text(
                    "INSERT INTO public.boards (id, scope, name) "
                    "VALUES (:id, 'project', 'Owned Board')"
                ),
                {"id": fixture.ids["board"]},
            )
            connection.execute(
                text(
                    "INSERT INTO public.dashboards (id, department_id, name) "
                    "VALUES (:id, :department, 'Owned Dashboard')"
                ),
                {"id": fixture.ids["dashboard"], "department": fixture.ids["department"]},
            )
        yield fixture
    finally:
        fixture.clean()
        if fixture.revision() != HEAD:
            fixture.upgrade()
        fixture.runtime.dispose()
        fixture.owner.dispose()
