"""Guarded Alembic helpers for disposable PostgreSQL migration regressions."""

import os
import subprocess
import sys

from tests.conftest import _guard_integration_database


def guarded_migration_environment() -> dict[str, str]:
    runtime_url = os.getenv("TEST_DATABASE_URL", "")
    owner_url = os.getenv("MIGRATION_DATABASE_URL", "")
    _guard_integration_database(runtime_url)
    _guard_integration_database(owner_url)
    return {**os.environ, "OPENSLATE_ENV_SOURCE": "process"}


def run_alembic(environment: dict[str, str], operation: str, revision: str) -> None:
    subprocess.run(
        [sys.executable, "-m", "alembic", operation, revision],
        check=True,
        env=environment,
    )
