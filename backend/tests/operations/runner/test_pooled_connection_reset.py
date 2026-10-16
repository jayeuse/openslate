"""A pooled test connection returns to the pool reset, and stays usable across many tests."""

import os

import pytest
from sqlalchemy import event

from tests.conftest import guarded_create_engine
from tests.database_pool import _discard_session_state

# Run often enough that psycopg prepares it (its threshold is five executions).
PREPARED_RUNS = 7


@pytest.mark.integration
def test_reused_connection_resets_session_state_and_keeps_prepared_statements_valid() -> None:
    engine = guarded_create_engine(
        os.environ["MIGRATION_DATABASE_URL"], pool_size=1, max_overflow=0
    )
    event.listen(engine, "checkin", _discard_session_state)
    statement = "SELECT set_config('openslate.pool_reset_probe', %(value)s, true)"
    try:
        # One test that prepares nothing, then two that commit after a prepared statement
        # (a rollback would clear psycopg's cache itself). A reset that drops psycopg's
        # prepared statements behind its back fails the third.
        with engine.connect() as connection:
            connection.exec_driver_sql("SET application_name = 'leaked-test-state'")
            connection.commit()
        for _test in range(2):
            with engine.connect() as connection:
                assert connection.exec_driver_sql("SHOW application_name").scalar() != (
                    "leaked-test-state"
                )
                for run in range(PREPARED_RUNS):
                    assert connection.exec_driver_sql(
                        statement, {"value": str(run)}
                    ).scalar() == str(run)
                connection.commit()
    finally:
        engine.dispose()
