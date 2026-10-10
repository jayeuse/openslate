"""Guarded Alembic helpers for disposable PostgreSQL migration regressions.

``run_alembic`` runs Alembic in this test process instead of a child ``python -m alembic``.
A child paid for a new interpreter and a fresh import of the application models on every
call. ``migrations/env.py`` still runs in full for every command, so its runner-ownership
guard, owner-role checks, migration scope, and advisory lock keep their meaning. A failure
raises ``subprocess.CalledProcessError``, as the child process did.
"""

import logging
import os
import subprocess
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from functools import partial
from pathlib import Path

from alembic import command
from alembic.config import Config

from tests.conftest import _guard_integration_database

_SCRIPT_LOCATION = str(Path(__file__).resolve().parents[2] / "migrations")
# alembic.ini's console format for the ``alembic`` logger.
_LOG_FORMAT = "%(levelname)-5.5s [%(name)s] %(message)s"
_REVISION_COMMANDS = {"upgrade": command.upgrade, "downgrade": command.downgrade}


def guarded_migration_environment() -> dict[str, str]:
    runtime_url = os.getenv("TEST_DATABASE_URL", "")
    owner_url = os.getenv("MIGRATION_DATABASE_URL", "")
    _guard_integration_database(runtime_url)
    _guard_integration_database(owner_url)
    return {**os.environ, "OPENSLATE_ENV_SOURCE": "process"}


@contextmanager
def _process_environment(environment: dict[str, str]) -> Iterator[None]:
    """Give env.py exactly the environment a child process would have received."""
    saved = dict(os.environ)
    os.environ.clear()
    os.environ.update(environment)
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(saved)


@contextmanager
def _alembic_console() -> Iterator[None]:
    """Keep the child's ``Running upgrade ...`` lines on stderr.

    The config has no ini file, so env.py skips ``logging.fileConfig``; in this process that
    call would disable every logger that other tests already created.
    """
    logger = logging.getLogger("alembic")
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(_LOG_FORMAT))
    level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        yield
    finally:
        logger.removeHandler(handler)
        logger.setLevel(level)


def run_alembic(environment: dict[str, str], operation: str, revision: str | None = None) -> None:
    """Run ``alembic upgrade|downgrade <revision>`` or ``alembic check``."""
    config = Config()
    config.set_main_option("script_location", _SCRIPT_LOCATION)
    call: Callable[[], object]
    if operation == "check" and revision is None:
        arguments = [operation]
        call = partial(command.check, config)
    elif operation in _REVISION_COMMANDS and revision is not None:
        arguments = [operation, revision]
        call = partial(_REVISION_COMMANDS[operation], config, revision)
    else:
        raise ValueError(f"Unsupported Alembic call: {operation} {revision}")
    try:
        with _process_environment(environment), _alembic_console():
            call()
    except Exception as error:
        raise subprocess.CalledProcessError(
            1, [sys.executable, "-m", "alembic", *arguments], stderr=str(error)
        ) from error
