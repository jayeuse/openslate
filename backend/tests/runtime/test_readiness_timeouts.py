"""Readiness keeps completed required results when a provider probe stalls."""

from threading import Event
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core import readiness
from app.main import create_app
from tests.runtime.readiness_support import (
    component,
    install_readiness_settings,
    readiness_settings,
    reset_readiness_state,
)


def test_blocked_storage_probe_preserves_completed_core_and_one_shared_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reset_readiness_state()
    started = Event()
    release = Event()
    closing = Event()
    release_close = Event()
    storage_calls = 0
    client_calls = 0

    def provider(request: httpx.Request) -> httpx.Response:
        nonlocal storage_calls
        if request.url.path == "/storage/v1/status":
            storage_calls += 1
            if storage_calls == 1:
                started.set()
                assert release.wait(2), "blocked storage probe was never released"
        return httpx.Response(200, request=request)

    class Client:
        def __init__(self, *args: object, **kwargs: object) -> None:
            nonlocal client_calls
            client_calls += 1
            self._second = client_calls == 2
            self._client = httpx.Client(*args, transport=httpx.MockTransport(provider), **kwargs)

        def __enter__(self) -> httpx.Client:
            return self._client.__enter__()

        def __exit__(self, *details: object) -> None:
            if self._second:
                closing.set()
                assert release_close.wait(2), "the second client close was never released"
            self._client.__exit__(*details)

    # Stage real provider work separately from the caller's real-time deadline.
    monkeypatch.setattr(readiness, "monotonic", lambda: 0.0)
    settings = readiness_settings(readiness_caller_timeout_seconds=0.1)
    install_readiness_settings(monkeypatch, settings)
    monkeypatch.setattr(
        readiness, "httpx", SimpleNamespace(Client=Client, HTTPError=httpx.HTTPError)
    )
    client = TestClient(create_app())

    try:
        readiness._get_or_start_snapshot()
        assert started.wait(5), "the first probe never reached Storage"
        first = client.get("/api/ready")
        assert started.is_set()
        assert first.status_code == 503
        assert first.json() == {
            "status": "not_ready",
            "components": {
                "database": component("ready"),
                "auth": component("ready"),
                "storage": component("unavailable"),
                "smtp": component("ready"),
            },
        }
        second = client.get("/api/ready")
        assert second.status_code == 503
        assert second.json() == first.json()
        assert storage_calls == 1

        release.set()
        assert readiness._snapshot_future is not None
        readiness._snapshot_future.result(timeout=1)
        fresh_future, _ = readiness._get_or_start_snapshot()
        assert closing.wait(5), "the fresh probe never reached the second client close"
        recovered = client.get("/api/ready")
        assert recovered.status_code == 200
        assert recovered.json()["components"]["storage"] == component("ready")
        assert storage_calls == 2
        release_close.set()
        assert fresh_future.result(timeout=1)["status"] == "ready"
    finally:
        release.set()
        release_close.set()
        try:
            if readiness._snapshot_future is not None:
                readiness._snapshot_future.result(timeout=1)
        finally:
            reset_readiness_state()


def test_a_caller_past_its_deadline_keeps_the_storage_result_while_the_client_closes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reset_readiness_state()
    closing = Event()
    release = Event()

    def provider(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request)

    class Client:
        def __init__(self, *args: object, **kwargs: object) -> None:
            self._client = httpx.Client(*args, transport=httpx.MockTransport(provider), **kwargs)

        def __enter__(self) -> httpx.Client:
            return self._client.__enter__()

        def __exit__(self, *details: object) -> None:
            closing.set()
            assert release.wait(2), "the stalled client close was never released"
            self._client.__exit__(*details)

    # Probe deadlines never lapse here; only the caller's own wait uses real time.
    monkeypatch.setattr(readiness, "monotonic", lambda: 0.0)
    install_readiness_settings(
        monkeypatch, readiness_settings(readiness_caller_timeout_seconds=0.1)
    )
    monkeypatch.setattr(
        readiness, "httpx", SimpleNamespace(Client=Client, HTTPError=httpx.HTTPError)
    )

    try:
        readiness._get_or_start_snapshot()
        assert closing.wait(5), "the provider probes never reached the client close"
        snapshot = readiness.get_readiness_snapshot()
        # Auth and storage finished before the deadline; only the client close stalled.
        assert snapshot["components"] == {
            "database": component("ready"),
            "auth": component("ready"),
            "storage": component("ready"),
            "smtp": component("ready"),
        }
    finally:
        release.set()
        reset_readiness_state()
