"""The `csv_sha256` revision hashes every stored run, and its downgrade removes the column."""

import os
from collections.abc import Iterator

import pytest
from sqlalchemy import Connection, Engine, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool
from uuid6 import uuid7

from tests.conftest import alembic_heads, create_organization, guarded_create_engine
from tests.database_pool import dispose_process_engines
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration

REVISION = "cf8cb7605f48"
PREVIOUS = "65bf3d1eb512"
CSV = b"Name\r\nReady\r\n"
# sha256sum of CSV, written out so the test does not rebuild what the revision computes.
CSV_SHA256 = "a19ca5dd8310ebad59c9245ea23a5d81dc6ea5dc9800a5983bbf5d4c262a6c33"


@pytest.fixture
def migration() -> Iterator[tuple[dict[str, str], Engine]]:
    """The test starts at the previous revision and hands the database back at the head."""
    environment = guarded_migration_environment()
    [head] = alembic_heads()
    dispose_process_engines()
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    run_alembic(environment, "downgrade", PREVIOUS)
    try:
        yield environment, engine
    finally:
        run_alembic(environment, "upgrade", head)
        engine.dispose()


def _column(connection: Connection) -> str | None:
    return connection.scalar(
        text(
            "SELECT is_nullable FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'report_runs' "
            "AND column_name = 'csv_sha256'"
        )
    )


def test_upgrade_hashes_stored_runs_and_downgrade_keeps_them_without_the_column(
    migration: tuple[dict[str, str], Engine],
) -> None:
    environment, engine = migration
    ids = {name: uuid7() for name in ("department", "module", "report", "run", "empty")}
    with Session(engine) as db:
        ids["org"] = create_organization(db).id
        db.commit()
    try:
        with engine.begin() as connection:
            for statement in (
                "INSERT INTO public.departments (id, org_id, department_name) "
                "VALUES (:department, :org, 'Hash backfill')",
                "INSERT INTO public.modules (id, org_id, department_id, module_name) "
                "VALUES (:module, :org, :department, 'Hash backfill')",
                "INSERT INTO public.reports (id, org_id, module_id, name, recipe) "
                "VALUES (:report, :org, :module, 'Hash backfill', '{}'::jsonb)",
            ):
                connection.execute(text(statement), ids)
            for run, content in ((ids["run"], CSV), (ids["empty"], b"")):
                connection.execute(
                    text(
                        "INSERT INTO public.report_runs (id, org_id, report_id, module_id, "
                        "idempotency_key, recipe_revision, recipe, headings, row_count, "
                        "csv_bytes) VALUES (:id, :org, :report, :module, :key, 1, '{}'::jsonb, "
                        "'[]'::jsonb, 0, :csv)"
                    ),
                    {**ids, "id": run, "key": uuid7(), "csv": content},
                )

        run_alembic(environment, "upgrade", REVISION)

        with engine.connect() as connection:
            assert _column(connection) == "NO"
            stored = dict(
                connection.execute(
                    text("SELECT id, csv_sha256 FROM public.report_runs WHERE report_id = :report"),
                    ids,
                ).all()
            )
        assert stored == {
            ids["run"]: CSV_SHA256,
            ids["empty"]: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        }

        run_alembic(environment, "downgrade", PREVIOUS)

        with engine.connect() as connection:
            assert _column(connection) is None
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM public.report_runs WHERE report_id = :report"), ids
                )
                == 2
            )
    finally:
        with engine.begin() as connection:
            for statement in (
                "DELETE FROM public.report_runs WHERE report_id = :report",
                "DELETE FROM public.reports WHERE id = :report",
                "DELETE FROM public.modules WHERE id = :module",
                "DELETE FROM public.departments WHERE id = :department",
                "DELETE FROM public.organizations WHERE id = :org",
            ):
                connection.execute(text(statement), ids)
