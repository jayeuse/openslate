import json
import os
import re
from collections.abc import Generator
from pathlib import Path
from secrets import token_urlsafe
from urllib.parse import urlsplit

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database import model_registry  # noqa: F401
from app.core.database.session import AuditSession
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from tests.config_support import settings_environment

MOCK_DATABASE_PASSWORD = token_urlsafe(32)

if os.getenv("TEST_DATABASE_URL") is None and os.getenv("E2E_ALLOW_MUTATIONS") != "true":
    os.environ.update(settings_environment())
    os.environ["OPENSLATE_ENV_SOURCE"] = "process"


def _guard_integration_database(database_url: str) -> None:
    """Allow integration tests to touch only the disposable local Supabase DB."""

    run_id = os.getenv("OPENSLATE_FULLSTACK_RUN_ID", "")
    try:
        parsed = urlsplit(database_url)
        manifest_path = Path(os.environ["OPENSLATE_TEST_DATABASE_MANIFEST"])
        manifest = json.loads(manifest_path.read_text())
        allowed = (
            os.getenv("E2E_ALLOW_MUTATIONS") == "true"
            and re.fullmatch(r"[a-f0-9]{32}", run_id) is not None
            and parsed.scheme == "postgresql+psycopg"
            and parsed.hostname == "127.0.0.1" and parsed.port == 55322
            and parsed.path == "/postgres" and not parsed.query and not parsed.fragment
            and parsed.username in {"postgres", "openslate_runtime"} and parsed.password
            and all(
                database_url != os.getenv(name) or parsed.username == role
                for name, role in (
                    ("TEST_DATABASE_URL", "openslate_runtime"),
                    ("MIGRATION_DATABASE_URL", "postgres"),
                )
            )
            and manifest_path.stat().st_mode & 0o077 == 0
            and manifest["run_id"] == run_id and database_url in manifest["urls"]
        )
    except (KeyError, OSError, ValueError, TypeError):
        allowed = False
    if not allowed:
        raise RuntimeError("Database tests require the runner-owned disposable database manifest")


def guarded_create_engine(database_url, **options):
    """Guard direct test connections as well as shared session fixtures."""
    _guard_integration_database(database_url)
    return create_engine(database_url, **options)


@pytest.fixture(autouse=True)
def _guard_direct_database_tests(request):
    if request.node.get_closest_marker("integration") and os.getenv("TEST_DATABASE_URL"):
        _guard_integration_database(os.environ["TEST_DATABASE_URL"])
        _guard_integration_database(os.getenv("MIGRATION_DATABASE_URL", ""))


def pytest_collection_modifyitems(session, config, items):
    if os.getenv("OPENSLATE_REQUIRE_DATABASE_TESTS") == "true":
        _guard_integration_database(os.getenv("TEST_DATABASE_URL", ""))
        _guard_integration_database(os.getenv("MIGRATION_DATABASE_URL", ""))


def pytest_sessionfinish(session, exitstatus):
    if os.getenv("OPENSLATE_REQUIRE_DATABASE_TESTS") == "true":
        reporter = session.config.pluginmanager.get_plugin("terminalreporter")
        if reporter and reporter.stats.get("skipped"):
            session.exitstatus = pytest.ExitCode.TESTS_FAILED


def _assert_alembic_head(connection) -> None:
    migrations = Path(__file__).parents[1] / "migrations"
    config = Config()
    config.set_main_option("script_location", str(migrations))
    heads = set(ScriptDirectory.from_config(config).get_heads())
    applied = set(
        connection.execute(text("SELECT version_num FROM alembic_version")).scalars().all()
    )
    if applied != heads:
        raise RuntimeError(f"Integration database is not at Alembic head: {applied!r}")


@pytest.fixture
def integration_db() -> Generator[Session, None, None]:
    database_url = os.getenv("TEST_DATABASE_URL")
    if database_url is None:
        pytest.skip("Set TEST_DATABASE_URL to run PostgreSQL integration tests")
    yield from _integration_session(database_url)


@pytest.fixture
def integration_owner_db() -> Generator[Session, None, None]:
    """Owner-only fixture setup for the explicitly created disposable full-stack DB."""
    if os.getenv("TEST_DATABASE_URL") is None:
        pytest.skip("Set TEST_DATABASE_URL to run PostgreSQL integration tests")
    database_url = os.getenv("MIGRATION_DATABASE_URL", "")
    _guard_integration_database(database_url)
    yield from _integration_session(database_url)


def _integration_session(database_url: str) -> Generator[Session, None, None]:
    _guard_integration_database(database_url)

    engine = create_engine(database_url)
    connection = engine.connect()
    _assert_alembic_head(connection)
    connection.rollback()
    transaction = connection.begin()
    session = AuditSession(bind=connection, join_transaction_mode="create_savepoint")
    session.info[AUDIT_CONTEXT_KEY] = AuditContext(
        request_id=uuid7(),
        request_method="POST",
        request_path="/api/test",
    )
    try:
        yield session
    finally:
        session.close()
        if transaction.is_active:
            transaction.rollback()
        connection.close()
        engine.dispose()
