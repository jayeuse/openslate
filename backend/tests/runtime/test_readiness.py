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
from app.core.config import ConfigurationError, Settings
from app.main import create_app
from app.systems.platform.files.providers import ProviderUnavailable
from tests.config_support import settings_values

MOCK_DATABASE_PASSWORD = token_urlsafe(32)
READINESS_BODY_CANARY = "provider-health-body-must-not-leak"
READINESS_PUBLISHABLE_KEY = "sb_publishable_readiness_test_only"


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
    readiness._snapshot_future = None
    readiness.get_readiness_engine.cache_clear()


def _readiness_settings(**overrides: object) -> Settings:
    values = settings_values(
        supabase_url="http://supabase.test",
        supabase_publishable_key=READINESS_PUBLISHABLE_KEY,
        readiness_caller_timeout_seconds=0.5,
        smtp_host="mailpit",
        smtp_port=1025,
        smtp_admin_email="admin@openslate.test",
    )
    values.update(overrides)
    return Settings(**values, _env_file=None)


def _install_provider_transport(monkeypatch, handler):
    transport = httpx.MockTransport(handler)

    def client_factory(*args, **kwargs):
        kwargs["transport"] = transport
        return httpx.Client(*args, **kwargs)

    # A private facade avoids replacing httpx.Client globally, which TestClient
    # itself uses. The readiness module imports this module at implementation.
    provider_http = SimpleNamespace(
        Client=client_factory,
        Timeout=httpx.Timeout,
        HTTPError=httpx.HTTPError,
        RequestError=httpx.RequestError,
        TimeoutException=httpx.TimeoutException,
    )
    monkeypatch.setattr(readiness, "httpx", provider_http, raising=False)


def _install_readiness_settings(monkeypatch, settings: Settings) -> None:
    import app.main as main

    def missing_scanner_configuration(*, require_configuration: bool = False):
        assert require_configuration
        raise ConfigurationError("test scanner configuration is absent")

    monkeypatch.setattr(readiness, "get_settings", lambda: settings)
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    monkeypatch.setattr(readiness, "_probe_database", lambda: True)
    monkeypatch.setattr(readiness, "get_scanner", missing_scanner_configuration, raising=False)


def _component(status: str, *, required: bool = True) -> dict[str, object]:
    return {"status": status, "required": required}


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

    settings = _readiness_settings()
    _install_readiness_settings(monkeypatch, settings)
    _install_provider_transport(monkeypatch, provider)

    response = TestClient(create_app()).get("/api/ready")

    expected = {
        "status": "ready",
        "components": {
            "database": _component("ready"),
            "auth": _component("ready"),
            "storage": _component("ready"),
            "smtp": _component("ready"),
            "scanner": _component("not_configured", required=False),
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

    _install_readiness_settings(monkeypatch, _readiness_settings())
    _install_provider_transport(monkeypatch, provider)

    response = TestClient(create_app()).get("/api/ready")

    assert response.status_code == 503
    assert response.json() == {
        "status": "not_ready",
        "components": {
            "database": _component("ready"),
            "auth": _component("unavailable"),
            "storage": _component("ready"),
            "smtp": _component("ready"),
            "scanner": _component("not_configured", required=False),
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

    _install_readiness_settings(
        monkeypatch,
        _readiness_settings(**{missing_fact: None}),
    )
    _install_provider_transport(monkeypatch, provider)

    response = TestClient(create_app()).get("/api/ready")

    assert response.status_code == 503
    assert response.json()["components"]["smtp"] == _component("not_configured")
    assert response.json()["components"]["scanner"] == _component(
        "not_configured", required=False
    )
    assert requests == [
        ("GET", "/auth/v1/health"),
        ("GET", "/storage/v1/status"),
    ]


def test_production_scanner_configuration_is_required(monkeypatch) -> None:
    def provider(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request)

    settings = _readiness_settings(
        environment="production",
        public_origin="https://openslate.test",
        web_assets_root="/tmp",
    )
    _install_readiness_settings(monkeypatch, settings)
    _install_provider_transport(monkeypatch, provider)

    snapshot = readiness._probe_components()

    assert snapshot["status"] == "not_ready"
    assert snapshot["components"]["scanner"] == _component("not_configured")


@pytest.mark.parametrize(
    ("environment", "leader_present", "required", "scanner_status", "overall"),
    [
        ("test", False, False, "unavailable", "ready"),
        ("production", False, True, "unavailable", "not_ready"),
        ("test", True, False, "ready", "ready"),
        ("production", True, True, "ready", "ready"),
    ],
)
def test_configured_scanner_requires_the_worker_leader(
    monkeypatch,
    environment: str,
    leader_present: bool,
    required: bool,
    scanner_status: str,
    overall: str,
) -> None:
    def provider(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request)

    class Scanner:
        probe_calls = 0

        def probe(self) -> None:
            self.probe_calls += 1

    scanner = Scanner()
    settings_overrides = (
        {"public_origin": "https://openslate.test", "web_assets_root": "/tmp"}
        if environment == "production"
        else {}
    )
    settings = _readiness_settings(environment=environment, **settings_overrides)
    _install_readiness_settings(monkeypatch, settings)
    _install_provider_transport(monkeypatch, provider)
    monkeypatch.setattr(readiness, "get_scanner", lambda *, require_configuration: scanner)
    monkeypatch.setattr(
        readiness,
        "_probe_scanner_worker_leader",
        lambda: leader_present,
        raising=False,
    )

    snapshot = readiness._probe_components()

    assert snapshot["status"] == overall
    assert snapshot["components"]["scanner"] == _component(
        scanner_status, required=required
    )
    assert scanner.probe_calls == int(leader_present)


def test_scanner_engine_probe_failure_cannot_be_hidden_by_a_live_worker_lock(monkeypatch) -> None:
    def provider(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request)

    class Scanner:
        def probe(self) -> None:
            raise ProviderUnavailable("scanner canary must not be returned")

    _install_readiness_settings(
        monkeypatch,
        _readiness_settings(
            environment="production",
            public_origin="https://openslate.test",
            web_assets_root="/tmp",
        ),
    )
    _install_provider_transport(monkeypatch, provider)
    monkeypatch.setattr(readiness, "get_scanner", lambda *, require_configuration: Scanner())
    monkeypatch.setattr(readiness, "_probe_scanner_worker_leader", lambda: True, raising=False)

    snapshot = readiness._probe_components()

    assert snapshot["status"] == "not_ready"
    assert snapshot["components"]["scanner"] == _component("unavailable")
    assert "canary" not in repr(snapshot)


@pytest.mark.parametrize("leader_present", [True, False])
def test_scanner_leader_probe_is_read_only_and_matches_the_worker_lock(
    monkeypatch,
    leader_present: bool,
) -> None:
    from app.systems.platform.files.worker import LEADER_LOCK

    connection = MagicMock()
    connection.scalar.return_value = leader_present
    engine = MagicMock()
    engine.connect.return_value.__enter__.return_value = connection
    monkeypatch.setattr(readiness, "get_readiness_engine", lambda: engine)

    assert readiness._probe_scanner_worker_leader() is leader_present

    statements = [call.args[0].text for call in connection.execute.call_args_list]
    assert statements == ["SET TRANSACTION READ ONLY"]
    sql, parameters = connection.scalar.call_args.args
    normalized_sql = " ".join(sql.text.casefold().split())
    assert "from pg_locks" in normalized_sql
    assert "locktype = 'advisory'" in normalized_sql
    assert "objsubid = 1" in normalized_sql
    assert "granted" in normalized_sql
    assert "mode = 'exclusivelock'" in normalized_sql
    assert "database" in normalized_sql
    assert "pg_backend_pid()" in normalized_sql
    assert "pg_try_advisory_lock" not in normalized_sql
    assert parameters == {
        "lock_classid": LEADER_LOCK >> 32,
        "lock_objid": LEADER_LOCK & 0xFFFFFFFF,
    }


def test_readiness_deadline_callers_share_the_same_in_flight_provider_probe(monkeypatch) -> None:
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
            assert release.wait(1)
            completed.set()
        return httpx.Response(200, request=request)

    settings = _readiness_settings(readiness_caller_timeout_seconds=0.03)
    _install_readiness_settings(monkeypatch, settings)
    _install_provider_transport(monkeypatch, provider)
    client = TestClient(create_app())
    gate = Barrier(3)

    def call_readiness():
        gate.wait(timeout=1)
        return client.get("/api/ready")

    try:
        with ThreadPoolExecutor(max_workers=2) as callers:
            futures = [callers.submit(call_readiness) for _ in range(2)]
            gate.wait(timeout=1)
            assert started.wait(0.5), "readiness did not probe the configured Auth health path"
            responses = [future.result(timeout=0.5) for future in futures]

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
    settings = _readiness_settings(readiness_caller_timeout_seconds=0.01)

    def report(ready: bool) -> readiness.ReadinessSnapshot:
        status = "ready" if ready else "unavailable"
        return {
            "status": "ready" if ready else "not_ready",
            "components": {
                "database": _component(status),
                "auth": _component(status),
                "storage": _component(status),
                "smtp": _component(status),
                "scanner": _component("not_configured", required=False),
            },
        }

    def probe(_partial=None) -> readiness.ReadinessSnapshot:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            started.set()
            assert release.wait(1)
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
