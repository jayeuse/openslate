"""A migration that cannot get a table lock fails after the migration lock limit."""

import os
import subprocess

import pytest
from sqlalchemy import text
from sqlalchemy.pool import NullPool

from tests.conftest import alembic_heads, guarded_create_engine
from tests.database_pool import dispose_process_engines
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration


def test_migration_gives_up_on_a_held_table_lock_instead_of_waiting() -> None:
    # F9: a migration that waits for a lock queues every request behind it. env.py limits
    # lock waits to 5 s; the holder's own 30 s idle limit is this test's hang guard.
    environment = guarded_migration_environment()
    assert alembic_heads()
    dispose_process_engines()
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    try:
        with engine.connect() as holder:
            holder.execute(text("SET idle_in_transaction_session_timeout = '30s'"))
            holder.commit()
            holder.execute(text("LOCK TABLE public.alembic_version IN ACCESS EXCLUSIVE MODE"))
            with pytest.raises(subprocess.CalledProcessError) as failure:
                run_alembic(environment, "upgrade", "head")
            assert "lock timeout" in failure.value.stderr
            holder.rollback()
        run_alembic(environment, "check")
    finally:
        engine.dispose()
