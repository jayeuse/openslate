"""S2: GET /api/system/status reports plain part statuses from a 30-second readiness cache."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier, Event, Lock
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_current_user
from app.core import readiness
from app.core.database.session import get_db
from app.main import create_app
from app.systems.manage.health import history, installation, organization, service
from tests.runtime.readiness_support import (
    install_provider_transport,
    install_readiness_settings,
    readiness_settings,
    reset_readiness_state,
)

# Hang guard for thread hand-offs only; no latency claim rests on it.
HANDOFF_SECONDS = 30
CHECK_TIME = datetime(2026, 11, 2, 10, 42, 5, 123456, tzinfo=UTC)
NO_HISTORY = history.HealthHistory(
    periods=(), slow=frozenset(), oldest_sample_at=None,
    email_accepted_at=None, email_failed_at=None,
)


def _snapshot(database="ready", auth="ready", storage="ready", smtp="ready"):
    return {
        "status": "ready",
        "components": {
            "database": {"status": database, "required": True},
            "auth": {"status": auth, "required": True},
            "storage": {"status": storage, "required": True},
            "smtp": {"status": smtp, "required": True},
        },
    }


class _Clock:
    def __init__(self) -> None:
        self.monotonic = 1_000.0
        self.wall = CHECK_TIME

    def advance(self, seconds: float) -> None:
        self.monotonic += seconds
        self.wall += timedelta(seconds=seconds)


@pytest.fixture(autouse=True)
def fresh_state(monkeypatch):
    reset_readiness_state()
    monkeypatch.setattr(service, "_cached", None)
    try:
        yield
    finally:
        reset_readiness_state()


@pytest.fixture
def clock(monkeypatch) -> _Clock:
    fake = _Clock()
    monkeypatch.setattr(service, "monotonic", lambda: fake.monotonic)
    monkeypatch.setattr(service, "utc_now", lambda: fake.wall)
    return fake


@pytest.fixture
def probes(monkeypatch) -> list[int]:
    calls: list[int] = []

    def counting_snapshot():
        calls.append(1)
        return _snapshot(storage="unavailable")

    monkeypatch.setattr(service, "get_readiness_snapshot", counting_snapshot)
    return calls


def test_s2_c2_a_second_call_within_thirty_seconds_reuses_the_probe_and_its_time(clock, probes):
    first = service.cached_readiness()
    clock.advance(29.999)
    second = service.cached_readiness()

    assert len(probes) == 1
    assert first == second
    assert second[1] == CHECK_TIME


def test_s2_c2_a_call_thirty_seconds_after_the_probe_probes_again(clock, probes):
    service.cached_readiness()
    clock.advance(30)
    _snapshot_used, checked_at = service.cached_readiness()

    assert len(probes) == 2
    assert checked_at == CHECK_TIME + timedelta(seconds=30)


def test_s2_c2_the_caller_timeout_fallback_is_cached_too(monkeypatch, clock):
    held = Event()
    entered: list[int] = []
    install_readiness_settings(
        monkeypatch, readiness_settings(readiness_caller_timeout_seconds=0.01)
    )

    def held_probe(partial=None):
        held.wait(HANDOFF_SECONDS)
        return _snapshot()

    real_snapshot = service.get_readiness_snapshot

    def counting_snapshot():
        entered.append(1)
        return real_snapshot()

    monkeypatch.setattr(readiness, "_probe_components", held_probe)
    monkeypatch.setattr(service, "get_readiness_snapshot", counting_snapshot)
    try:
        fallback, checked_at = service.cached_readiness()
        clock.advance(10)
        again = service.cached_readiness()
    finally:
        held.set()

    assert fallback["components"]["database"]["status"] == "unavailable"
    assert again == (fallback, checked_at)
    assert len(entered) == 1


def test_s2_c2_concurrent_misses_share_one_probe_and_one_check_time(monkeypatch, clock):
    install_readiness_settings(
        monkeypatch, readiness_settings(readiness_caller_timeout_seconds=HANDOFF_SECONDS)
    )
    release = Event()
    probe_calls: list[int] = []
    probe_lock = Lock()
    both_waiting = Barrier(2, action=release.set, timeout=HANDOFF_SECONDS)
    real_start = readiness._get_or_start_snapshot

    def probe(partial=None):
        with probe_lock:
            probe_calls.append(1)
        release.wait(HANDOFF_SECONDS)
        return _snapshot(auth="unavailable")

    def start_then_wait():
        started = real_start()
        # Both callers hold the same in-flight probe before it may finish.
        both_waiting.wait()
        return started

    monkeypatch.setattr(readiness, "_probe_components", probe)
    monkeypatch.setattr(readiness, "_get_or_start_snapshot", start_then_wait)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [future.result(HANDOFF_SECONDS) for future in
                   [pool.submit(service.cached_readiness) for _ in range(2)]]

    assert probe_calls == [1]
    assert results[0] == results[1]


@pytest.mark.parametrize(
    ("component", "value", "key", "status"),
    [
        ("database", "ready", "data", "working"),
        ("database", "unavailable", "data", "not_working"),
        ("database", "not_configured", "data", "not_set_up"),
        ("database", None, "data", "not_working"),
        ("auth", "ready", "signing_in", "working"),
        ("auth", "unavailable", "signing_in", "not_working"),
        ("auth", "not_configured", "signing_in", "not_set_up"),
        ("auth", None, "signing_in", "not_working"),
        ("storage", "ready", "files", "working"),
        ("storage", "unavailable", "files", "not_working"),
        ("storage", "not_configured", "files", "not_set_up"),
        ("storage", None, "files", "not_working"),
        # S2-C3: configuration presence is never proof that mail is delivered.
        ("smtp", "ready", "email", "set_up"),
        ("smtp", "unavailable", "email", "not_working"),
        ("smtp", "not_configured", "email", "not_set_up"),
        ("smtp", None, "email", "not_working"),
    ],
)
def test_s2_c3_each_readiness_value_maps_to_its_part_status(component, value, key, status):
    snapshot = _snapshot()
    if value is None:
        del snapshot["components"][component]
    else:
        snapshot["components"][component]["status"] = value

    parts = {part.key: part.status for part in service.system_parts(snapshot)}

    assert parts[key] == status


def _status_client(monkeypatch, events: list[str]) -> TestClient:
    def snapshot():
        events.append("probe")
        return _snapshot(storage="unavailable", smtp="not_configured")

    def organization_status(db, person):
        events.append("organization")

    def cached_history(db):
        events.append("history")
        return NO_HISTORY

    def installation_status(db, person):
        events.append("installation")

    database = Mock(spec=Session)
    database.rollback.side_effect = lambda: events.append("rollback")
    monkeypatch.setattr(service, "get_readiness_snapshot", snapshot)
    monkeypatch.setattr(organization, "organization_status", organization_status)
    monkeypatch.setattr(history, "cached_history", cached_history)
    monkeypatch.setattr(installation, "installation_status", installation_status)
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=None)
    app.dependency_overrides[get_db] = lambda: database
    return TestClient(app)


def test_s2_c1_c4_the_body_holds_only_parts_version_and_check_time(monkeypatch, clock):
    events: list[str] = []

    response = _status_client(monkeypatch, events).get("/api/system/status")

    assert response.status_code == 200
    assert response.json() == {
        "parts": [
            {"key": "data", "status": "working"},
            {"key": "signing_in", "status": "working"},
            {"key": "files", "status": "not_working"},
            {"key": "email", "status": "not_set_up"},
        ],
        "version": "0.1.0",
        "checked_at": "2026-11-02T10:42:05.123456Z",
        "organization": None,
        "installation": None,
    }
    for internal in ("database", "auth", "storage", "smtp", "supabase", "required", "5432"):
        assert internal not in response.text
    assert response.headers["Cache-Control"] == "no-store"
    # The request transaction ends before the readiness wait, and again after the
    # organization, history and installation reads, so no pooled connection idles in a
    # transaction.
    assert events == [
        "rollback", "probe", "organization", "history", "installation", "rollback",
    ]


def test_s2_c1_a_request_with_no_session_gets_401_with_a_request_id():
    response = TestClient(create_app()).get("/api/system/status")

    assert response.status_code == 401
    assert response.json() == {
        "detail": "Invalid authentication credentials",
        "request_id": response.headers["X-Request-ID"],
    }


def test_s2_c8_api_ready_still_probes_on_every_call_after_a_cached_status(monkeypatch):
    probed: list[int] = []
    install_readiness_settings(monkeypatch, readiness_settings())
    install_provider_transport(monkeypatch, lambda request: httpx.Response(200, request=request))
    monkeypatch.setattr(readiness, "_probe_database", lambda: probed.append(1) or True)
    monkeypatch.setattr(organization, "organization_status", lambda db, person: None)
    monkeypatch.setattr(history, "cached_history", lambda db: NO_HISTORY)
    monkeypatch.setattr(installation, "installation_status", lambda db, person: None)
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=None)
    app.dependency_overrides[get_db] = lambda: Mock(spec=Session)
    client = TestClient(app)

    assert client.get("/api/system/status").status_code == 200
    first, second = client.get("/api/ready"), client.get("/api/ready")

    assert len(probed) == 3
    assert first.status_code == second.status_code == 200
    assert "request_id" not in first.json()
