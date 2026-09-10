import os
from collections.abc import Callable
from time import perf_counter

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as SQLAlchemyTimeoutError
from sqlalchemy.orm import Session

from tests.conftest import guarded_create_engine as create_engine

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


def _runtime_engine(*, statement_timeout_ms: int = 1_000) -> Engine:
    assert TEST_DATABASE_URL is not None
    return create_engine(
        TEST_DATABASE_URL,
        pool_size=1,
        max_overflow=0,
        pool_timeout=0.1,
        pool_pre_ping=True,
        connect_args={
            "connect_timeout": 3,
            "options": f"-c statement_timeout={statement_timeout_ms}",
        },
    )


def test_runtime_pool_checkout_timeout_recovers_after_connection_release(
    integration_db: Session,
    record_property: Callable[[str, str], None],
) -> None:
    assert integration_db.connection().scalar(text("SELECT 1")) == 1
    engine = _runtime_engine()
    held_connection = engine.connect()
    try:
        started = perf_counter()
        with pytest.raises(SQLAlchemyTimeoutError):
            engine.connect()
        record_property("pool_checkout_wait_seconds", f"{perf_counter() - started:.3f}")
    finally:
        held_connection.close()

    try:
        with engine.connect() as recovered_connection:
            assert recovered_connection.scalar(text("SELECT 1")) == 1
    finally:
        engine.dispose()


def test_runtime_statement_timeout_rolls_back_and_reuses_the_connection(
    integration_db: Session,
    record_property: Callable[[str, str], None],
) -> None:
    assert integration_db.connection().scalar(text("SELECT 1")) == 1
    engine = _runtime_engine(statement_timeout_ms=100)
    try:
        with engine.connect() as connection:
            started = perf_counter()
            with pytest.raises(OperationalError):
                connection.execute(text("SELECT pg_sleep(0.25)"))
            record_property("statement_timeout_wait_seconds", f"{perf_counter() - started:.3f}")

            connection.rollback()
            assert connection.scalar(text("SELECT 1")) == 1

        with engine.connect() as reused_connection:
            assert reused_connection.scalar(text("SELECT 1")) == 1
    finally:
        engine.dispose()


def test_readiness_connection_enforces_read_only_mode(integration_db: Session) -> None:
    assert TEST_DATABASE_URL is not None
    assert integration_db.connection().scalar(text("SELECT 1")) == 1
    engine = create_engine(
        TEST_DATABASE_URL,
        pool_size=1,
        max_overflow=0,
        pool_timeout=0.25,
        pool_pre_ping=True,
        connect_args={
            "connect_timeout": 1,
            "options": "-c statement_timeout=500 -c default_transaction_read_only=on",
        },
    )
    try:
        with engine.connect() as connection:
            assert connection.scalar(text("SHOW transaction_read_only")) == "on"
            connection.rollback()
    finally:
        engine.dispose()
