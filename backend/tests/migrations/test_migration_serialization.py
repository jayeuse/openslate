"""Concurrent `alembic upgrade` runs stay serialized on the migration lock."""

import os
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from time import monotonic, sleep

import pytest
from sqlalchemy import Connection, text
from sqlalchemy.pool import NullPool

from tests.conftest import alembic_heads, guarded_create_engine
from tests.database_pool import dispose_process_engines
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
BACKEND = Path(__file__).resolve().parents[2]
LOCK = "slateops:alembic"
_QUEUED = text(
    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
    "AND wait_event_type = 'Lock' AND wait_event = 'advisory'"
)


def _start(environment: dict[str, str]) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=BACKEND, env=environment, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )


def _until(
    observer: Connection,
    runs: Sequence[subprocess.Popen[str]],
    ready: Callable[[Connection], object],
) -> object:
    """Poll ``ready`` until it is truthy; a 60 s hang guard, never a timing assertion."""
    deadline = monotonic() + 60
    while not (result := ready(observer)):
        ended = [run.communicate()[0][-1500:] for run in runs if run.poll() is not None]
        assert not ended, ended
        assert monotonic() < deadline, "the upgrade runs never reached the expected state"
        sleep(0.05)
    return result


def test_a_second_upgrade_waits_for_the_first_and_then_finds_nothing_to_run() -> None:
    # Both runs queue on the migration lock. The run that gets it second must read the
    # alembic_version that the first run committed and run no revision again.
    environment = guarded_migration_environment()
    [head] = alembic_heads()
    dispose_process_engines()
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    runs: list[subprocess.Popen[str]] = []
    try:
        run_alembic(environment, "downgrade", "base")
        with (
            engine.connect() as holder,
            engine.connect().execution_options(isolation_level="AUTOCOMMIT") as observer,
        ):
            holder.execute(text("SELECT pg_advisory_lock(hashtext(:lock))"), {"lock": LOCK})
            holder.commit()
            runs = [_start(environment), _start(environment)]
            _until(observer, runs, lambda o: o.scalar(_QUEUED) == 2)
            holder.execute(text("SELECT pg_advisory_unlock(hashtext(:lock))"), {"lock": LOCK})
            holder.commit()
        outputs = [run.communicate(timeout=120)[0] for run in runs]
    finally:
        for run in runs:
            if run.poll() is None:
                run.kill()
                run.communicate()
        run_alembic(environment, "upgrade", head)
        engine.dispose()

    assert [run.returncode for run in runs] == [0, 0], outputs
    upgraded = [f"Running upgrade  -> {head}" in output for output in outputs]
    assert sorted(upgraded) == [False, True], outputs
    waited = outputs[upgraded.index(False)]
    assert "Running upgrade" not in waited, outputs
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == head
