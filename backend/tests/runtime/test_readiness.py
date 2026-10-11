from concurrent.futures import Future, ThreadPoolExecutor
from hashlib import sha256
from secrets import token_urlsafe
from threading import Barrier, Event, Lock
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from app.core import readiness
from app.core.config import Settings
from app.main import create_app
from tests.config_support import settings_values
from tests.runtime.readiness_support import (
    READINESS_PUBLISHABLE_KEY,
    component,
    install_provider_transport,
    install_readiness_settings,
    readiness_settings,
    reset_readiness_state,
)

MOCK_DATABASE_PASSWORD = token_urlsafe(32)
READINESS_BODY_CANARY = "provider-health-body-must-not-leak"


@pytest.fixture(autouse=True)
def readiness_state() -> None:
    reset_readiness_state()
    try:
        yield
    finally:
        reset_readiness_state()


def test_readiness_route_reports_auth_and_storage_as_separate_components(monkeypatch) -> None:
    observed: list[tuple[str, str, str | None, bool, bool]] = []
    observed_lock = Lock()

    def provider(request: httpx.Request) -> httpx.Response:
        with observed_lock:
            observed.append(
                (
                    request.method,
                    request.url.path,
                    sha256(request.headers.get("apikey", "").encode()).hexdigest()
                    if request.headers.get("apikey")
                    else None,
                    "authorization" in request.headers,
                    bool(request.url.query),
                )
            )
        return httpx.Response(
            200,
            content=READINESS_BODY_CANARY.encode(),
            request=request,
        )

    settings = readiness_settings()
    install_readiness_settings(monkeypatch, settings)
    install_provider_transport(monkeypatch, provider)

    response = TestClient(create_app()).get("/api/ready")

    expected = {
        "status": "ready",
        "components": {
            "database": component("ready"),
            "auth": component("ready"),
            "storage": component("ready"),
            "smtp": component("ready"),
        },
    }
    assert response.status_code == 200
    assert response.json() == expected
    assert response.headers["Cache-Control"] == "no-store"
    assert READINESS_BODY_CANARY not in response.text
    assert "supabase.test" not in response.text
    assert READINESS_PUBLISHABLE_KEY not in response.text
    assert sorted((method, path) for method, path, *_ in observed) == [
        ("GET", "/auth/v1/health"),
        ("GET", "/storage/v1/status"),
    ]
    assert all(
        key_fingerprint == sha256(READINESS_PUBLISHABLE_KEY.encode()).hexdigest()
        and not has_authorization
        and not has_query
        for _, _, key_fingerprint, has_authorization, has_query in observed
    )


def test_readiness_provider_outage_is_component_specific_and_redacted(monkeypatch) -> None:
    def provider(request: httpx.Request) -> httpx.Response:
        status = 503 if request.url.path == "/auth/v1/health" else 200
        return httpx.Response(status, content=READINESS_BODY_CANARY.encode(), request=request)

    install_readiness_settings(monkeypatch, readiness_settings())
    install_provider_transport(monkeypatch, provider)

    response = TestClient(create_app()).get("/api/ready")

    assert response.status_code == 503
    assert response.json() == {
        "status": "not_ready",
        "components": {
            "database": component("ready"),
            "auth": component("unavailable"),
            "storage": component("ready"),
            "smtp": component("ready"),
        },
    }
    assert response.headers["Cache-Control"] == "no-store"
    assert READINESS_BODY_CANARY not in response.text
    assert "supabase.test" not in response.text


@pytest.mark.parametrize(
    "missing_fact",
    [
        "smtp_host",
        "smtp_port",
        "smtp_admin_email",
    ],
)
def test_smtp_readiness_requires_configuration_without_sending_mail(
    monkeypatch,
    missing_fact: str,
) -> None:
    requests: list[tuple[str, str]] = []

    def provider(request: httpx.Request) -> httpx.Response:
        requests.append((request.method, request.url.path))
        return httpx.Response(200, request=request)

    install_readiness_settings(
        monkeypatch,
        readiness_settings(**{missing_fact: None}),
    )
    install_provider_transport(monkeypatch, provider)

    response = TestClient(create_app()).get("/api/ready")

    assert response.status_code == 503
    assert response.json()["components"]["smtp"] == component("not_configured")
    assert requests == [
        ("GET", "/auth/v1/health"),
        ("GET", "/storage/v1/status"),
    ]


def test_readiness_deadline_callers_share_the_same_in_flight_provider_probe(monkeypatch) -> None:
    # Isolate sharing from probe-start scheduling; Future.result still times out in real time.
    monkeypatch.setattr(readiness, "monotonic", lambda: 0.0)
    # A real database connection under parallel coverage load can outlast the 0.5 s
    # wait below before the Auth probe starts; sharing does not depend on it.
    monkeypatch.setattr(readiness, "_probe_database", lambda: True)
    started = Event()
    release = Event()
    completed = Event()
    request_count = 0
    request_lock = Lock()

    def provider(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        if request.url.path == "/auth/v1/health":
            with request_lock:
                request_count += 1
            started.set()
            # Held well past the 5 s bounds below: a caller that blocked on this in-flight
            # probe instead of answering at its own deadline would fail the test.
            assert release.wait(10)
            completed.set()
        return httpx.Response(200, request=request)

    settings = readiness_settings(readiness_caller_timeout_seconds=0.03)
    install_readiness_settings(monkeypatch, settings)
    install_provider_transport(monkeypatch, provider)
    client = TestClient(create_app())
    gate = Barrier(3)

    def call_readiness():
        gate.wait(timeout=1)
        return client.get("/api/ready")

    try:
        with ThreadPoolExecutor(max_workers=2) as callers:
            futures = [callers.submit(call_readiness) for _ in range(2)]
            gate.wait(timeout=1)
            # Generous bounds tolerate thread scheduling under parallel load; the held probe
            # above keeps them a latency proof, and one provider request proves sharing.
            assert started.wait(5), "readiness did not probe the configured Auth health path"
            responses = [future.result(timeout=5) for future in futures]

        assert [response.status_code for response in responses] == [503, 503]
        assert request_count == 1
    finally:
        release.set()
        completed.wait(1)


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
    settings = readiness_settings(readiness_caller_timeout_seconds=0.01)

    def report(ready: bool) -> readiness.ReadinessSnapshot:
        status = "ready" if ready else "unavailable"
        return {
            "status": "ready" if ready else "not_ready",
            "components": {
                "database": component(status),
                "auth": component(status),
                "storage": component(status),
                "smtp": component(status),
            },
        }

    def probe(_partial=None) -> readiness.ReadinessSnapshot:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            started.set()
            # Held well past the 5 s bounds below: a caller that blocked on this in-flight
            # probe instead of answering at its own deadline would fail the test.
            assert release.wait(10)
            completed.set()
            return report(False)
        return report(True)

    monkeypatch.setattr(readiness, "get_settings", lambda: settings)
    monkeypatch.setattr(readiness, "_probe_components", probe)

    try:
        assert readiness.get_readiness_snapshot()["status"] == "not_ready"
        assert started.wait(0.5)
        assert readiness.get_readiness_snapshot()["status"] == "not_ready"
        assert call_count == 1

        release.set()
        assert completed.wait(0.5)
        assert readiness._snapshot_future is not None
        assert readiness._snapshot_future.result(timeout=0.5)["status"] == "not_ready"
        assert readiness.get_readiness_snapshot()["status"] == "ready"
        assert call_count == 2
    finally:
        release.set()


def test_readiness_cleanup_disposes_the_pool_and_cancels_future_work(monkeypatch) -> None:
    engine = Mock(spec=Engine)
    executor = ThreadPoolExecutor(max_workers=1)
    pending = Future[readiness.ReadinessSnapshot]()
    get_engine = Mock(return_value=engine)
    get_engine.cache_info.return_value = SimpleNamespace(currsize=1)

    monkeypatch.setattr(readiness, "get_readiness_engine", get_engine)
    readiness._probe_executor = executor
    readiness._snapshot_future = pending

    readiness.dispose_readiness_resources()

    engine.dispose.assert_called_once_with()
    get_engine.cache_clear.assert_called_once_with()
    assert readiness._probe_executor is None
    assert readiness._snapshot_future is None
    with pytest.raises(RuntimeError):
        executor.submit(lambda: None)
