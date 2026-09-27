"""Readiness keeps completed required results when the scanner stalls."""

from threading import Event

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core import readiness
from app.main import create_app
from tests.runtime.test_readiness import (
    _component,
    _install_provider_transport,
    _install_readiness_settings,
    _readiness_settings,
    _reset_readiness_state,
)


@pytest.mark.parametrize(
    ("environment", "first_status"),
    [("test", 200), ("production", 503)],
)
def test_blocked_scanner_preserves_completed_core_and_one_shared_probe(
    monkeypatch: pytest.MonkeyPatch, environment: str, first_status: int
) -> None:
    _reset_readiness_state()
    started = Event()
    release = Event()
    probe_calls = 0

    class Scanner:
        def probe(self) -> None:
            nonlocal probe_calls
            probe_calls += 1
            if probe_calls == 1:
                started.set()
                assert release.wait(2), "blocked scanner was never released"

    overrides = (
        {"public_origin": "https://openslate.test", "web_assets_root": "/tmp"}
        if environment == "production"
        else {}
    )
    settings = _readiness_settings(
        environment=environment, readiness_caller_timeout_seconds=0.1, **overrides
    )
    _install_readiness_settings(monkeypatch, settings)
    _install_provider_transport(
        monkeypatch, lambda request: httpx.Response(200, request=request)
    )
    scanner = Scanner()
    monkeypatch.setattr(readiness, "get_scanner", lambda *, require_configuration: scanner)
    monkeypatch.setattr(readiness, "_probe_scanner_worker_leader", lambda: True)
    if environment == "production":
        monkeypatch.setattr("app.main.StaticSite.load", lambda _root: None)
    client = TestClient(
        create_app(),
        base_url="https://openslate.test" if environment == "production" else "http://testserver",
    )

    try:
        first = client.get("/api/ready")
        assert started.is_set()
        assert first.status_code == first_status
        assert first.json() == {
            "status": "ready" if environment == "test" else "not_ready",
            "components": {
                "database": _component("ready"),
                "auth": _component("ready"),
                "storage": _component("ready"),
                "smtp": _component("ready"),
                "scanner": _component("unavailable", required=environment == "production"),
            },
        }
        second = client.get("/api/ready")
        assert second.status_code == first_status
        assert second.json() == first.json()
        assert probe_calls == 1

        release.set()
        assert readiness._snapshot_future is not None
        readiness._snapshot_future.result(timeout=1)
        recovered = client.get("/api/ready")
        assert recovered.status_code == 200
        assert recovered.json()["components"]["scanner"] == _component(
            "ready", required=environment == "production"
        )
        assert probe_calls == 2
    finally:
        release.set()
        _reset_readiness_state()
