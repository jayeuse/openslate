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
    thread = None
    try:
        worker.start()
        thread = worker._thread
        assert thread is not None
        worker.start()
        assert entered.wait(timeout=1), "The durable queue was not polled"
        assert worker.stop() is False
        assert worker._stop.is_set(), "stop() did not request shutdown"
    finally:
        worker._stop.set()
        release.set()
        if thread is not None:
            thread.join(timeout=2)
            assert not thread.is_alive(), "The sign-out worker did not terminate"
    assert worker.stop() is True
    assert len(calls) == 1


@pytest.mark.parametrize(
    "signout_failure,retention_failure,event_failure",
    [
        (False, False, False),
        (True, False, False),
        (False, True, False),
        (False, False, True),
        (True, True, True),
    ],
)
def test_retention_runs_initially_hourly_and_failures_do_not_couple_phases(
    monkeypatch, signout_failure, retention_failure, event_failure
):
    elapsed = [0.0]
    calls = []

    class ClockStop:
        def is_set(self):
            return elapsed[0] > 3600

        def wait(self, seconds):
            assert seconds == 30
            elapsed[0] += seconds

    worker = module.ProviderSignoutWorker(Settings(**settings_values(), _env_file=None))
    worker._stop = ClockStop()
    monkeypatch.setattr(module, "monotonic", lambda: elapsed[0], raising=False)

    def signout():
        calls.append(("signout", elapsed[0]))
        if signout_failure:
            raise RuntimeError("Owned unavailable provider")
        return 0

    def retention():
        calls.append(("retention", elapsed[0]))
        if retention_failure:
            raise RuntimeError("Owned unavailable database")
        return 0

    def event_retention():
        calls.append(("event_retention", elapsed[0]))
        if event_failure:
            raise RuntimeError("Owned unavailable event retention")
        return 0

    monkeypatch.setattr(worker, "run_once", signout)
    monkeypatch.setattr(worker, "_run_retention_once", retention, raising=False)
    monkeypatch.setattr(worker, "_run_event_retention_once", event_retention, raising=False)
    worker._run()
    assert [time for phase, time in calls if phase == "retention"] == [0, 3600]
    assert [time for phase, time in calls if phase == "event_retention"] == [0, 3600]
    assert len([phase for phase, _ in calls if phase == "signout"]) == 121


def test_stop_during_signout_prevents_another_retention_phase(monkeypatch):
    worker = module.ProviderSignoutWorker(Settings(**settings_values(), _env_file=None))
    monkeypatch.setattr(worker, "run_once", lambda: worker._stop.set())
    calls = []
    monkeypatch.setattr(worker, "_run_retention_once", lambda: calls.append(True), raising=False)
    worker._run()
    assert calls == []


def test_stop_reports_inflight_retention_until_its_transaction_finishes(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    worker = module.ProviderSignoutWorker(Settings(**settings_values(), _env_file=None))
    monkeypatch.setattr(worker, "run_once", lambda: 0)
    monkeypatch.setattr(module, "_SHUTDOWN_SECONDS", 0.01)

    def retention():
        entered.set()
        assert release.wait(timeout=2)
        return 0

    monkeypatch.setattr(worker, "_run_retention_once", retention, raising=False)
    thread = None
    try:
        worker.start()
        thread = worker._thread
        assert thread is not None
        assert entered.wait(timeout=1), "Due retention was not attempted"
        assert worker.stop() is False
        assert worker._stop.is_set(), "stop() did not request shutdown"
    finally:
        worker._stop.set()
        release.set()
        if thread is not None:
            thread.join(timeout=2)
            assert not thread.is_alive(), "The retention worker did not terminate"
        assert worker.stop() is True
