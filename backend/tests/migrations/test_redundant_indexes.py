"""No index repeats what another index on its table already provides."""

import os

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from tests.conftest import alembic_heads, guarded_create_engine
from tests.database_pool import dispose_process_engines
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
BEFORE_DROPS = "e10810d4789c"

# Index A is redundant when index B on the same table has the same access method and
# predicate, and A's key columns (with their operator classes and sort options) are B's
# first key columns. A unique A is kept unless B is unique on exactly the same columns.
_REDUNDANT = text(
    """
    SELECT a.indexrelid::regclass::text AS redundant, b.indexrelid::regclass::text AS kept
      FROM pg_index AS a
      JOIN pg_index AS b ON b.indrelid = a.indrelid AND b.indexrelid <> a.indexrelid
      JOIN pg_class AS ia ON ia.oid = a.indexrelid
      JOIN pg_class AS ib ON ib.oid = b.indexrelid
      JOIN pg_class AS t ON t.oid = a.indrelid
      JOIN pg_namespace AS n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND ia.relam = ib.relam
       AND a.indexprs IS NULL AND b.indexprs IS NULL
       AND coalesce(pg_get_expr(a.indpred, a.indrelid), '')
           = coalesce(pg_get_expr(b.indpred, b.indrelid), '')
       AND a.indnkeyatts <= b.indnkeyatts
       AND (a.indkey::int2[])[0:a.indnkeyatts - 1] = (b.indkey::int2[])[0:a.indnkeyatts - 1]
       AND (a.indclass::oid[])[0:a.indnkeyatts - 1] = (b.indclass::oid[])[0:a.indnkeyatts - 1]
       AND (a.indoption::int2[])[0:a.indnkeyatts - 1]
           = (b.indoption::int2[])[0:a.indnkeyatts - 1]
       AND (NOT a.indisunique
            OR (b.indisunique AND a.indnkeyatts = b.indnkeyatts AND a.indexrelid > b.indexrelid))
     ORDER BY 1, 2
    """
)


def test_no_index_is_covered_by_another_index_with_the_same_predicate(
    integration_owner_db: Session,
) -> None:
    # Development data on 2026-10-31: ix_users_email and ix_users_username repeated their
    # unique constraints, and ix_relationship_edges_active_source (13 MB, 0 scans) was the
    # leading part of uq_relationship_edges_active; each one only cost writes.
    connection = integration_owner_db.connection()
    redundant = [tuple(row) for row in connection.execute(_REDUNDANT)]
    assert redundant == []


def test_a_downgrade_rebuilds_an_index_left_invalid_by_a_failed_concurrent_build() -> None:
    # A concurrent build that stops (for example at the 5 s lock limit) leaves an INVALID
    # index of the same name; a rerun must not take that index as already built.
    environment = guarded_migration_environment()
    [head] = alembic_heads()
    dispose_process_engines()
    engine = guarded_create_engine(
        os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool, isolation_level="AUTOCOMMIT"
    )
    try:
        with engine.connect() as connection:
            connection.execute(text("CREATE TABLE public.index_rerun_probe (value integer)"))
            connection.execute(text("INSERT INTO public.index_rerun_probe VALUES (1), (1)"))
            with pytest.raises(IntegrityError):
                connection.execute(text(
                    "CREATE UNIQUE INDEX CONCURRENTLY ix_users_email "
                    "ON public.index_rerun_probe (value)"
                ))
            assert connection.scalar(text(
                "SELECT indisvalid FROM pg_index "
                "WHERE indexrelid = 'public.ix_users_email'::regclass"
            )) is False

        run_alembic(environment, "downgrade", BEFORE_DROPS)

        with engine.connect() as connection:
            rebuilt = connection.execute(text(
                "SELECT indrelid::regclass::text, indisvalid FROM pg_index "
                "WHERE indexrelid = 'public.ix_users_email'::regclass"
            )).one()
            assert tuple(rebuilt) == ("users", True)
    finally:
        run_alembic(environment, "upgrade", head)
        with engine.connect() as connection:
            connection.execute(text("DROP TABLE IF EXISTS public.index_rerun_probe"))
        engine.dispose()
