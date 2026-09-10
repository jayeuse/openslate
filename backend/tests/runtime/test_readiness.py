from concurrent.futures import Future, ThreadPoolExecutor
from secrets import token_urlsafe
from threading import Barrier, Event
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest
from sqlalchemy import Engine

from app.core import readiness
from app.core.config import Settings
from tests.config_support import settings_values

MOCK_DATABASE_PASSWORD = token_urlsafe(32)


@pytest.fixture(autouse=True)
def readiness_state() -> None:
    _reset_readiness_state()
    try:
        yield
    finally:
        _reset_readiness_state()


def _reset_readiness_state() -> None:
    executor = readiness._probe_executor
    if executor is not None:
        executor.shutdown(wait=False, cancel_futures=True)
    readiness._probe_executor = None
    readiness._probe_future = None
    readiness.get_readiness_engine.cache_clear()


def test_readiness_probe_uses_an_explicit_read_only_transaction(monkeypatch) -> None:
    connection = MagicMock()
    engine = MagicMock()
    engine.connect.return_value.__enter__.return_value = connection
    monkeypatch.setattr(readiness, "get_readiness_engine", lambda: engine)

    assert readiness._probe_database() is True

    connection.execute.assert_called()
    statements = [call.args[0].text for call in connection.execute.call_args_list]
    assert statements == ["SET TRANSACTION READ ONLY", "SELECT 1"]


def test_readiness_engine_has_a_dedicated_bounded_read_only_pool(monkeypatch) -> None:
    captured: dict[str, object] = {}
    engine = Mock(spec=Engine)
    settings = Settings(
        **settings_values(
            database_url=f"postgresql+psycopg://test:{MOCK_DATABASE_PASSWORD}@localhost/test"
        ),
        _env_file=None,
    )

    def create_engine_spy(*args: object, **kwargs: object) -> Mock:
        captured.update(kwargs)
        return engine

    monkeypatch.setattr(readiness, "get_settings", lambda: settings)
    monkeypatch.setattr(readiness, "create_engine", create_engine_spy)
    readiness.get_readiness_engine.cache_clear()

    assert readiness.get_readiness_engine() is engine
    assert captured["pool_size"] == 1
    assert captured["max_overflow"] == 0
    assert captured["pool_timeout"] == 0.25
    assert captured["connect_args"] == {
        "connect_timeout": 1,
        "options": "-c statement_timeout=500 -c default_transaction_read_only=on",
    }


def test_timed_out_readiness_call_does_not_start_a_replacement_and_recovers(
    monkeypatch,
    readiness_state,
) -> None:
    started = Event()
    release = Event()
    completed = Event()
    call_count = 0
    settings = Settings(
        **settings_values(
            database_url=f"postgresql+psycopg://test:{MOCK_DATABASE_PASSWORD}@localhost/test",
            readiness_caller_timeout_seconds=0.01,
        ),
        _env_file=None,
    )

    def probe() -> bool:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            started.set()
            assert release.wait(1)
            completed.set()
            return False
        return True

    monkeypatch.setattr(readiness, "get_settings", lambda: settings)
    monkeypatch.setattr(readiness, "_probe_database", probe)

    try:
        assert readiness.is_database_ready() is False
        assert started.wait(0.5)
        assert readiness.is_database_ready() is False
        assert call_count == 1

        release.set()
        assert completed.wait(0.5)
        assert readiness._probe_future is not None
        assert readiness._probe_future.result(timeout=0.5) is False
        assert readiness.is_database_ready() is True
        assert call_count == 2
    finally:
        release.set()


def test_concurrent_timed_out_callers_share_the_same_in_flight_probe(
    monkeypatch,
    readiness_state,
) -> None:
    started = Event()
    release = Event()
    gate = Barrier(5)
    call_count = 0
    settings = Settings(
        **settings_values(
            database_url=f"postgresql+psycopg://test:{MOCK_DATABASE_PASSWORD}@localhost/test",
            readiness_caller_timeout_seconds=0.01,
        ),
        _env_file=None,
    )

    def probe() -> bool:
        nonlocal call_count
        call_count += 1
        started.set()
        assert release.wait(1)
        return False

    def caller() -> bool:
        gate.wait(timeout=1)
        return readiness.is_database_ready()

    monkeypatch.setattr(readiness, "get_settings", lambda: settings)
    monkeypatch.setattr(readiness, "_probe_database", probe)

    try:
        with ThreadPoolExecutor(max_workers=4) as callers:
            futures = [callers.submit(caller) for _ in range(4)]
            gate.wait(timeout=1)
            assert started.wait(0.5)
            assert [future.result(timeout=0.5) for future in futures] == [False] * 4
        assert call_count == 1
    finally:
        release.set()


def test_readiness_cleanup_disposes_the_pool_and_cancels_future_work(monkeypatch) -> None:
    engine = Mock(spec=Engine)
    executor = ThreadPoolExecutor(max_workers=1)
    pending = Future[bool]()
    get_engine = Mock(return_value=engine)
    get_engine.cache_info.return_value = SimpleNamespace(currsize=1)

    monkeypatch.setattr(readiness, "get_readiness_engine", get_engine)
    readiness._probe_executor = executor
    readiness._probe_future = pending

    readiness.dispose_readiness_resources()

    engine.dispose.assert_called_once_with()
    get_engine.cache_clear.assert_called_once_with()
    assert readiness._probe_executor is None
    assert readiness._probe_future is None
    with pytest.raises(RuntimeError):
        executor.submit(lambda: None)
