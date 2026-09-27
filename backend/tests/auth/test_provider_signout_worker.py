"""Deterministic thread shutdown proves no pool disposal during provider work."""

import threading

import pytest

from app.core.config import Settings
from app.systems.access.identity import provider_signout_worker as module
from tests.config_support import settings_values


def test_signout_worker_reports_inflight_work_until_it_finishes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered, release = threading.Event(), threading.Event()
    calls: list[bool] = []

    def blocked_batch() -> int:
        calls.append(True)
        entered.set()
        release.wait(timeout=2)
        return 1

    worker = module.ProviderSignoutWorker(Settings(**settings_values(), _env_file=None))
    monkeypatch.setattr(worker, "run_once", blocked_batch)
    monkeypatch.setattr(module, "_SHUTDOWN_SECONDS", 0.01, raising=False)
    try:
        worker.start()
        worker.start()
        assert entered.wait(timeout=1), "The durable queue was not polled"
        assert worker.stop() is False
    finally:
        release.set()
    assert worker.stop() is True
    assert len(calls) == 1
