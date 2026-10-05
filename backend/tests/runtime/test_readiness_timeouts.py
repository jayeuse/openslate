"""Readiness keeps completed required results when a provider probe stalls."""

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


def test_blocked_storage_probe_preserves_completed_core_and_one_shared_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _reset_readiness_state()
    started = Event()
    release = Event()
    storage_calls = 0

    def provider(request: httpx.Request) -> httpx.Response:
        nonlocal storage_calls
        if request.url.path == "/storage/v1/status":
            storage_calls += 1
            if storage_calls == 1:
                started.set()
                assert release.wait(2), "blocked storage probe was never released"
        return httpx.Response(200, request=request)

    settings = _readiness_settings(readiness_caller_timeout_seconds=0.1)
    _install_readiness_settings(monkeypatch, settings)
    _install_provider_transport(monkeypatch, provider)
    client = TestClient(create_app())

    try:
        first = client.get("/api/ready")
        assert started.is_set()
        assert first.status_code == 503
        assert first.json() == {
            "status": "not_ready",
            "components": {
                "database": _component("ready"),
                "auth": _component("ready"),
                "storage": _component("unavailable"),
                "smtp": _component("ready"),
            },
        }
        second = client.get("/api/ready")
        assert second.status_code == 503
        assert second.json() == first.json()
        assert storage_calls == 1

        release.set()
        assert readiness._snapshot_future is not None
        readiness._snapshot_future.result(timeout=1)
        recovered = client.get("/api/ready")
        assert recovered.status_code == 200
        assert recovered.json()["components"]["storage"] == _component("ready")
        assert storage_calls == 2
    finally:
        release.set()
        _reset_readiness_state()
