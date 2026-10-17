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
from sqlalchemy.exc import OperationalError

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
# Hang guard for thread hand-offs only. A worker process paused by swap can overrun any
# short bound, so no latency claim rests on it: those come from the order of events.
HANDOFF_SECONDS = 30


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
            # Held until `finally` releases it: a caller that blocked on this in-flight
            # probe instead of answering at its own deadline never answers inside `try`.
            assert release.wait(HANDOFF_SECONDS)
            completed.set()
        return httpx.Response(200, request=request)

    settings = readiness_settings(readiness_caller_timeout_seconds=0.03)
    install_readiness_settings(monkeypatch, settings)
    install_provider_transport(monkeypatch, provider)
    client = TestClient(create_app())
    gate = Barrier(3)

    def call_readiness():
        gate.wait(timeout=HANDOFF_SECONDS)
        return client.get("/api/ready")

    try:
        with ThreadPoolExecutor(max_workers=2) as callers:
            futures = [callers.submit(call_readiness) for _ in range(2)]
            gate.wait(timeout=HANDOFF_SECONDS)
            assert started.wait(HANDOFF_SECONDS), (
                "readiness did not probe the configured Auth health path"
            )
            responses = [future.result(timeout=HANDOFF_SECONDS) for future in futures]
            # Both callers answered while the probe was still held; one provider
            # request below proves they shared it.
            assert not completed.is_set()

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
            # Held until the test releases it: a caller that blocked on this in-flight
            # probe instead of answering at its own deadline would never return.
            assert release.wait(HANDOFF_SECONDS)
            completed.set()
            return report(False)
        return report(True)

    monkeypatch.setattr(readiness, "get_settings", lambda: settings)
    monkeypatch.setattr(readiness, "_probe_components", probe)

    try:
        # Nothing finished before the caller deadline: every probed component is unavailable.
        assert readiness.get_readiness_snapshot() == {
            "status": "not_ready",
            "components": {
                "database": component("unavailable"),
                "auth": component("unavailable"),
                "storage": component("unavailable"),
                "smtp": component("ready"),
            },
        }
        assert started.wait(HANDOFF_SECONDS)
        assert readiness.get_readiness_snapshot()["status"] == "not_ready"
        assert call_count == 1

        release.set()
        assert completed.wait(HANDOFF_SECONDS)
        assert readiness._snapshot_future is not None
        assert readiness._snapshot_future.result(timeout=HANDOFF_SECONDS)["status"] == "not_ready"
        # Recovery is the replacement probe's answer, not a race with a 0.01 s deadline.
        recovery = readiness_settings(readiness_caller_timeout_seconds=HANDOFF_SECONDS)
        monkeypatch.setattr(readiness, "get_settings", lambda: recovery)
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


def test_an_unreachable_database_is_reported_unavailable(monkeypatch) -> None:
    engine = MagicMock()
    engine.connect.side_effect = OperationalError("SELECT 1", {}, ConnectionRefusedError())
    monkeypatch.setattr(readiness, "get_readiness_engine", lambda: engine)

    assert readiness._probe_database() is False


@pytest.mark.parametrize(
    ("failure", "components"),
    [
        pytest.param(
            "connection",
            {"auth": component("ready"), "storage": component("unavailable")},
            id="storage-connection-refused",
        ),
        pytest.param(
            "redirect",
            {"auth": component("unavailable"), "storage": component("ready")},
            id="auth-redirect-not-followed",
        ),
    ],
)
def test_a_provider_that_refuses_or_redirects_is_unavailable(
    monkeypatch, failure: str, components: dict[str, object]
) -> None:
    paths: list[str] = []

    def provider(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if failure == "connection" and request.url.path == "/storage/v1/status":
            raise httpx.ConnectError("refused", request=request)
        if failure == "redirect" and request.url.path == "/auth/v1/health":
            return httpx.Response(
                302, headers={"Location": "http://supabase.test/elsewhere"}, request=request
            )
        return httpx.Response(200, request=request)

    install_readiness_settings(monkeypatch, readiness_settings())
    install_provider_transport(monkeypatch, provider)

    response = TestClient(create_app()).get("/api/ready")

    assert response.status_code == 503
    assert response.json()["components"] == {
        "database": component("ready"),
        **components,
        "smtp": component("ready"),
    }
    assert "/elsewhere" not in paths


@pytest.mark.parametrize(
    ("failure", "provider_status", "status"),
    [
        pytest.param("build", "unavailable", "not_ready", id="client-cannot-be-built"),
        pytest.param("close", "ready", "ready", id="close-fails-after-both-probes"),
    ],
)
def test_a_provider_client_failure_keeps_finished_probes_and_fails_the_rest_closed(
    monkeypatch, failure: str, provider_status: str, status: str
) -> None:
    def provider(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request)

    class Client:
        def __init__(self, *args: object, **kwargs: object) -> None:
            if failure == "build":
                raise httpx.TransportError("client cannot be built")
            self._client = httpx.Client(*args, transport=httpx.MockTransport(provider), **kwargs)

        def __enter__(self) -> httpx.Client:
            return self._client.__enter__()

        def __exit__(self, *details: object) -> None:
            self._client.__exit__(*details)
            raise httpx.TransportError("client cannot be closed")

    install_readiness_settings(monkeypatch, readiness_settings())
    monkeypatch.setattr(
        readiness, "httpx", SimpleNamespace(Client=Client, HTTPError=httpx.HTTPError)
    )

    snapshot = readiness._probe_components()

    assert snapshot["components"] == {
        "database": component("ready"),
        "auth": component(provider_status),
        "storage": component(provider_status),
        "smtp": component("ready"),
    }
    assert snapshot["status"] == status


BOUNDED = {"connect": 0.25, "read": 0.25, "write": 0.25, "pool": 0.25}


@pytest.mark.parametrize(
    ("elapsed", "provider_status", "request_timeouts"),
    [
        pytest.param(0.5, "unavailable", [], id="deadline-reached-sends-nothing"),
        pytest.param(0.25, "ready", [BOUNDED, BOUNDED], id="request-bounded-by-time-left"),
    ],
)
def test_provider_probes_are_bounded_by_the_caller_deadline(
    monkeypatch, elapsed: float, provider_status: str, request_timeouts: list[dict[str, float]]
) -> None:
    timeouts: list[dict[str, float | None]] = []

    def provider(request: httpx.Request) -> httpx.Response:
        timeouts.append(request.extensions["timeout"])
        return httpx.Response(200, request=request)

    readings = iter([0.0])
    # The deadline is read at 0.0; each provider probe then starts `elapsed` seconds later.
    monkeypatch.setattr(readiness, "monotonic", lambda: next(readings, elapsed))
    install_readiness_settings(
        monkeypatch, readiness_settings(readiness_caller_timeout_seconds=0.5)
    )
    install_provider_transport(monkeypatch, provider)

    snapshot = readiness._probe_components()

    assert snapshot["components"]["auth"] == component(provider_status)
    assert snapshot["components"]["storage"] == component(provider_status)
    assert timeouts == request_timeouts
