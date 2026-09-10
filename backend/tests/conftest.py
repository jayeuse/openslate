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
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from tests.config_support import settings_environment

MOCK_DATABASE_PASSWORD = token_urlsafe(32)

if os.getenv("TEST_DATABASE_URL") is None and os.getenv("E2E_ALLOW_MUTATIONS") != "true":
    os.environ.update(settings_environment())
    os.environ["OPENSLATE_ENV_SOURCE"] = "process"


def _guard_integration_database(database_url: str) -> None:
    """Allow integration tests to touch only the disposable local Supabase DB."""

    parsed = urlsplit(database_url)
    if parsed.scheme not in {"postgresql", "postgresql+psycopg", "postgres"}:
        raise RuntimeError("TEST_DATABASE_URL must use a PostgreSQL URL")
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("TEST_DATABASE_URL must target loopback")
    disposable_fullstack = (
        os.getenv("E2E_ALLOW_MUTATIONS") == "true"
        and re.fullmatch(r"[a-f0-9]{32}", os.getenv("OPENSLATE_FULLSTACK_RUN_ID", "")) is not None
        and parsed.hostname == "127.0.0.1"
        and parsed.port == 55322
    )
    if parsed.port != 54322 and not disposable_fullstack:
        raise RuntimeError("TEST_DATABASE_URL must target the local Supabase port")
    if parsed.path.rstrip("/") != "/postgres":
        raise RuntimeError("TEST_DATABASE_URL must target the local disposable postgres DB")


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
    target = urlsplit(database_url)
    if not (
        os.getenv("E2E_ALLOW_MUTATIONS") == "true"
        and re.fullmatch(r"[a-f0-9]{32}", os.getenv("OPENSLATE_FULLSTACK_RUN_ID", ""))
        and target.hostname == "127.0.0.1"
        and target.port == 55322
        and target.path == "/postgres"
        and target.username == "postgres"
        and target.password
    ):
        raise RuntimeError("Owner fixtures require the authorized disposable full-stack database")
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
