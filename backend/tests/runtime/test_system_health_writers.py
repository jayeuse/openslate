"""S5, S6: the timed probe, worker heartbeats and the server error log bounds (stack-free)."""

from threading import Event

import httpx
import pytest
from uuid6 import uuid7

from app.core import readiness
from app.systems.access.identity.provider_signout_worker import ProviderSignoutWorker
from app.systems.manage.health import errors, signals
from app.systems.platform.scheduling.worker import ReportSchedulingWorker
from app.systems.sandbox.record_triggers.worker import TriggerWorker
from tests.config_support import settings_values
from tests.runtime.readiness_support import (
    install_provider_transport,
    install_readiness_settings,
    readiness_settings,
    reset_readiness_state,
)

HANDOFF_SECONDS = 30


class _Clock:
    def __init__(self, step: float = 0.0) -> None:
        self.now = 100.0
        self.step = step

    def __call__(self) -> float:
        value = self.now
        self.now += self.step
        return value


@pytest.fixture(autouse=True)
def fresh_probe():
    reset_readiness_state()
    try:
        yield
    finally:
        reset_readiness_state()


def test_s5_c1_i3_each_timed_part_reports_the_time_it_took_inside_the_probe(monkeypatch):
    clock = _Clock()
    install_readiness_settings(
        monkeypatch, readiness_settings(readiness_caller_timeout_seconds=HANDOFF_SECONDS)
    )
    monkeypatch.setattr(readiness, "perf_counter", clock)

    def database() -> bool:
        clock.now += 1.2
        return True

    def provider(request: httpx.Request) -> httpx.Response:
        clock.now += 0.3 if "/auth/" in request.url.path else 0.05
        return httpx.Response(200, request=request)

    monkeypatch.setattr(readiness, "_probe_database", database)
    install_provider_transport(monkeypatch, provider)

    snapshot, times = readiness.get_timed_readiness_snapshot()

    assert snapshot["status"] == "ready"
    assert times == {"database": 1200, "auth": 300, "storage": 50}


def test_s5_c1_i3_on_the_caller_deadline_unfinished_parts_report_the_time_used(monkeypatch):
    held = Event()
    install_readiness_settings(
        monkeypatch, readiness_settings(readiness_caller_timeout_seconds=0.01)
    )
    # The probe starts at 100.0; the deadline reads 102.0.
    monkeypatch.setattr(readiness, "perf_counter", _Clock(step=2.0))
    monkeypatch.setattr(readiness, "_probe_database", lambda: held.wait(HANDOFF_SECONDS))
    try:
        snapshot, times = readiness.get_timed_readiness_snapshot()
    finally:
        held.set()

    assert snapshot["components"]["database"]["status"] == "unavailable"
    assert times == {"database": 2000, "auth": 2000, "storage": 2000}


def test_s5_c1_i3_a_probe_that_records_no_part_reports_no_time(monkeypatch):
    install_readiness_settings(
        monkeypatch, readiness_settings(readiness_caller_timeout_seconds=HANDOFF_SECONDS)
    )
    ready = {"status": "ready", "components": {}}
    monkeypatch.setattr(readiness, "_probe_components", lambda partial=None: ready)

    assert readiness.get_timed_readiness_snapshot() == (ready, {})
    assert readiness.get_readiness_snapshot() == ready


def test_s5_c6_i11_a_heartbeat_writes_at_most_once_a_minute_per_key(monkeypatch):
    clock = _Clock()
    writes: list[str] = []
    monkeypatch.setattr(signals, "monotonic", clock)
    monkeypatch.setattr(signals, "record_signal", writes.append)
    monkeypatch.setattr(signals, "_last_beats", {})

    signals.beat("record_triggers")
    clock.now += 59.9
    signals.beat("record_triggers")
    signals.beat("comms_jobs")
    clock.now += 0.1
    signals.beat("record_triggers")

    assert writes == ["record_triggers", "comms_jobs", "record_triggers"]


def test_s5_c8_a_failed_signal_write_is_logged_and_never_raised(monkeypatch):
    logged: list[tuple[str, dict]] = []

    def refuse(key, now):
        raise RuntimeError("database down")

    monkeypatch.setattr(signals, "_write_signal", refuse)
    monkeypatch.setattr(
        signals, "log_event", lambda event, **fields: logged.append((event, fields))
    )

    signals.record_signal("email_failed")

    assert logged == [("operational_attention",
                       {"reason_code": "health_signal_write_failed", "upstream": "database"})]


def _worker_settings():
    from app.core.config import Settings

    return Settings(**settings_values(), _env_file=None)


def _stop_after(worker, result=None):
    def once(*_args, **_kwargs):
        worker._stop.set()
        return result

    return once


def test_s5_c6_i11_each_in_app_worker_beats_after_its_pass(monkeypatch):
    beats: list[str] = []
    monkeypatch.setattr(signals, "beat", beats.append)

    triggers = TriggerWorker(_worker_settings())
    monkeypatch.setattr(triggers, "run_once", _stop_after(triggers, 0))
    triggers._run(1)
    triggers._stop.clear()
    triggers._run(0)

    signout = ProviderSignoutWorker(_worker_settings())
    monkeypatch.setattr(signout, "run_once", _stop_after(signout, 0))
    signout._run()

    scheduling = ReportSchedulingWorker(_worker_settings(), comms_poll=lambda now: None)
    monkeypatch.setattr(scheduling, "_poll", _stop_after(scheduling, []))
    scheduling._run()

    # Lane 1 never beats; only lane 0 speaks for the record-trigger worker.
    assert beats == ["record_triggers", "provider_signout", "report_scheduling", "comms_jobs"]


def _error_log(monkeypatch):
    clock = _Clock()
    writes: list[tuple] = []
    logged: list[tuple[str, dict]] = []
    monkeypatch.setattr(errors, "monotonic", clock)
    monkeypatch.setattr(errors, "_write", lambda *values: writes.append(values))
    monkeypatch.setattr(errors, "log_event", lambda event, **fields: logged.append((event, fields)))
    return errors.ServerErrorLog(), clock, writes, logged


def _record(log):
    log.record(uuid7(), 500, "GET", "/api/records/{record_id}", None)


def test_s6_c1_i15_writes_stop_at_120_a_minute_and_one_line_counts_the_overflow(monkeypatch):
    log, clock, writes, logged = _error_log(monkeypatch)

    for _ in range(123):
        _record(log)
    clock.now += 59.9
    _record(log)
    assert (len(writes), logged) == (120, [])

    clock.now += 0.1
    _record(log)

    assert len(writes) == 121
    assert logged == [("operational_attention",
                       {"reason_code": "server_error_log_dropped", "upstream": "database",
                        "count": 4})]


def test_s6_c1_i15_a_failed_write_pauses_writes_for_thirty_seconds(monkeypatch):
    log, clock, writes, logged = _error_log(monkeypatch)
    failing = [True]

    def write(*values):
        if failing.pop() if failing else False:
            raise RuntimeError("database down")
        writes.append(values)

    monkeypatch.setattr(errors, "_write", write)

    _record(log)
    clock.now += 29.9
    _record(log)
    assert writes == []
    clock.now += 0.1
    _record(log)

    assert len(writes) == 1
    assert logged == [("operational_attention",
                       {"reason_code": "server_error_log_failed", "upstream": "database"})]


def test_s6_c1_a_failed_write_never_raises_into_the_response(monkeypatch):
    def refuse(*values):
        raise RuntimeError("database down")

    monkeypatch.setattr(errors, "_write", refuse)
    monkeypatch.setattr(errors, "_log", errors.ServerErrorLog())

    errors.record_server_error(uuid7(), 500, "GET", "/api/records", None)
