"""Worker start/stop ownership stays safe around application shutdown."""

import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import Mock, call

import pytest
from fastapi import FastAPI
from uuid6 import uuid7

import app.main as main
from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.record_triggers.execution import ClaimedTriggerEvent
from app.systems.sandbox.record_triggers.runner import (
    _compare,
    _conditions_match,
    _trigger_matches,
)
from app.systems.sandbox.record_triggers.worker import TriggerWorker


@pytest.fixture(autouse=True)
def _one_organization(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    """Unit tests poll one organization without a database to list them."""
    if request.node.get_closest_marker("integration") is None:
        organization = uuid7()
        target = "app.systems.sandbox.record_triggers.worker.active_organization_ids"
        monkeypatch.setattr(target, lambda _engine: [organization])


def test_test_environment_never_starts_a_background_worker() -> None:
    worker = TriggerWorker(
        SimpleNamespace(environment="test", e2e_background_workers=False, trigger_workers=4)
    )

    worker.start()

    assert not worker.running
    assert worker.stop()


def test_stop_reports_when_a_worker_did_not_join() -> None:
    worker = TriggerWorker(SimpleNamespace(environment="development", trigger_workers=1))
    worker._threads = [SimpleNamespace(join=lambda **_kwargs: None, is_alive=lambda: True)]  # type: ignore[list-item]

    assert not worker.stop()


def test_runtime_comparisons_allow_null_equality_without_evaluating_ordering() -> None:
    assert _compare(None, "=", None)
    assert _compare(None, "!=", "value")
    assert not _compare(None, ">", 1)


def test_datetime_thresholds_compare_instants_instead_of_iso_text() -> None:
    field_id = uuid7()
    definition = SimpleNamespace(
        id=uuid7(),
        event_kind="threshold-crossed",
        trigger_field_id=field_id,
        trigger_value_kind="literal",
        trigger_literal_value={"value": "2025-01-01T00:00:00Z"},
        trigger_value_field_id=None,
        trigger_operator=">=",
    )
    event = SimpleNamespace(
        event_kind="field-changed",
        scheduled_trigger_id=None,
        changed_field_ids=[str(field_id)],
        values={str(field_id): "2025-01-01T01:00:00+02:00"},
        previous_values={str(field_id): "2024-12-31T22:00:00Z"},
    )
    fields = {field_id: SimpleNamespace(id=field_id, type=FieldType.DATETIME)}

    assert not _trigger_matches(event, definition, fields)
    assert _compare(
        "2025-01-01T00:00:00Z",
        "=",
        "2025-01-01T00:00:00+00:00",
        FieldType.DATETIME,
    )
    condition = SimpleNamespace(
        field_id=field_id,
        operator="<",
        value_kind="literal",
        literal_value={"value": "2025-01-01T00:00:00Z"},
        value_field_id=None,
    )
    assert _conditions_match(
        SimpleNamespace(data={str(field_id): "2025-01-01T01:00:00+02:00"}),
        SimpleNamespace(condition_operator="all"),
        [condition],
        fields,
    )


def test_claim_failure_logs_context_and_increases_the_next_idle_wait(monkeypatch) -> None:
    worker = TriggerWorker(SimpleNamespace(environment="development", trigger_workers=1))
    log_event = Mock()
    monkeypatch.setattr("app.systems.sandbox.record_triggers.worker.get_engine", Mock())
    monkeypatch.setattr(
        "app.systems.sandbox.record_triggers.worker.enqueue_due_schedules",
        Mock(side_effect=RuntimeError("database unavailable")),
    )
    monkeypatch.setattr("app.systems.sandbox.record_triggers.worker.log_event", log_event)

    assert worker.run_once() == 0

    assert worker._claim_retry_seconds == 2
    assert log_event.call_args.kwargs["reason_code"] == (
        "sandbox_trigger_claim_failed_runtimeerror"
    )


def test_claim_retry_delay_caps_and_resets_after_a_successful_claim_pass(monkeypatch) -> None:
    worker = TriggerWorker(SimpleNamespace(environment="development", trigger_workers=1))
    worker._claim_retry_seconds = 32
    monkeypatch.setattr("app.systems.sandbox.record_triggers.worker.get_engine", Mock())
    monkeypatch.setattr(
        "app.systems.sandbox.record_triggers.worker.enqueue_due_schedules",
        Mock(side_effect=RuntimeError("database unavailable")),
    )

    assert worker.run_once() == 0
    assert worker._claim_retry_seconds == 60

    database = Mock()
    session = Mock()
    session.__enter__ = Mock(return_value=database)  # type: ignore[attr-defined]
    session.__exit__ = Mock(return_value=False)  # type: ignore[attr-defined]
    monkeypatch.setattr(
        "app.systems.sandbox.record_triggers.worker.AuditSession", Mock(return_value=session)
    )
    monkeypatch.setattr("app.systems.sandbox.record_triggers.worker.enqueue_due_schedules", Mock())
    monkeypatch.setattr(
        "app.systems.sandbox.record_triggers.worker.claim_due_events", Mock(return_value=[])
    )

    assert worker.run_once() == 0
    assert worker._claim_retry_seconds == 1


def test_shutdown_releases_every_claim_that_was_not_executed(monkeypatch) -> None:
    worker = TriggerWorker(SimpleNamespace(environment="development", trigger_workers=1))
    claims = [
        ClaimedTriggerEvent(id=uuid7(), lease_token=uuid7()),
        ClaimedTriggerEvent(id=uuid7(), lease_token=uuid7()),
    ]
    worker._enqueue_and_claim = Mock(return_value=claims)  # type: ignore[method-assign]
    worker._execute = Mock()  # type: ignore[method-assign]
    worker._stop.set()
    database = Mock()
    session = Mock()
    session.__enter__ = Mock(return_value=database)  # type: ignore[attr-defined]
    session.__exit__ = Mock(return_value=False)  # type: ignore[attr-defined]
    release_claim = Mock(return_value=True)
    monkeypatch.setattr(
        "app.systems.sandbox.record_triggers.worker.AuditSession", Mock(return_value=session)
    )
    monkeypatch.setattr(
        "app.systems.sandbox.record_triggers.worker.release_claim", release_claim, raising=False
    )

    assert worker.run_once() == len(claims)

    worker._execute.assert_not_called()
    assert release_claim.call_args_list == [
        call(database, claims[0]),
        call(database, claims[1]),
    ]
    database.commit.assert_called_once_with()


def test_lifespan_keeps_database_pool_when_trigger_worker_is_alive(monkeypatch) -> None:
    app = FastAPI()
    app.state.events_listener = SimpleNamespace(start=lambda: None, stop=lambda: None)
    app.state.smtp_outbox_worker = SimpleNamespace(start=lambda: None, stop=lambda: None)
    app.state.trigger_worker = SimpleNamespace(start=lambda: None, stop=lambda: False)
    # create_app() always installs the Comms publisher; the lifespan starts and stops it.
    app.state.comms_publisher = SimpleNamespace(start=lambda: None, stop=lambda: True)
    dispose_database = Mock()
    dispose_readiness = Mock()
    monkeypatch.setattr(main, "configure_observability_logging", lambda: None)
    monkeypatch.setattr(main, "instance_target_for_process", lambda *_args: None)
    monkeypatch.setattr(main, "dispose_database_resources", dispose_database)
    monkeypatch.setattr(main, "dispose_readiness_resources", dispose_readiness)

    async def exercise() -> None:
        context = main.application_lifespan(app)
        await context.__aenter__()
        await context.__aexit__(None, None, None)

    asyncio.run(exercise())

    dispose_database.assert_not_called()
    dispose_readiness.assert_not_called()


def test_the_worker_reports_events_run_their_mean_time_and_the_longest_wait(monkeypatch) -> None:
    # Live seven-pack run: automations waited 16-21 s, and the worker logged no wait or run time.
    # Several lanes run events at once; they share one line per interval, not one per lane.
    from datetime import timedelta

    from app.core.base_model import utc_now
    from app.systems.sandbox.record_triggers import worker as trigger_worker

    worker = TriggerWorker(SimpleNamespace(environment="development", trigger_workers=4))
    events = []
    monkeypatch.setattr(trigger_worker, "log_event", lambda *a, **k: events.append((a, k)))
    monkeypatch.setattr(worker, "_run_claim", lambda _claim: None)
    together = threading.Barrier(4, timeout=10)

    def lane(waited_seconds: int) -> None:
        together.wait()
        for _event in range(50):
            queued = utc_now() - timedelta(seconds=waited_seconds)
            worker._execute(ClaimedTriggerEvent(uuid7(), uuid7(), queued))
        together.wait()
        worker._report_metrics()

    worker._metrics_started -= trigger_worker._METRICS_SECONDS
    lanes = [threading.Thread(target=lane, args=(seconds,)) for seconds in (0, 0, 0, 3)]
    for thread in lanes:
        thread.start()
    for thread in lanes:
        thread.join(10)

    ((name,), fields), = events
    assert name == "worker_metrics"
    assert fields["upstream"] == "sandbox-triggers" and fields["count"] == 200
    assert 3000 <= fields["age_ms"] < 10000


def test_an_idle_lane_polls_again_as_soon_as_another_lane_ran_events(monkeypatch) -> None:
    # A lane's runs queue follow-up events; an idle lane must not leave them for its next poll.
    worker = TriggerWorker(SimpleNamespace(environment="development", trigger_workers=2))
    worker._claim_retry_seconds = 60
    idle_polls = []
    first_idle_poll = threading.Event()
    polled_again = threading.Event()
    ran = threading.Event()

    def run_once(lane: int = 0) -> int:
        if lane == 1:
            if ran.is_set():
                worker._stop.wait(10)
                return 0
            # Run only after the idle lane found nothing, so its wait is the one tested.
            assert first_idle_poll.wait(10)
            ran.set()
            return 1
        idle_polls.append(lane)
        first_idle_poll.set()
        if len(idle_polls) == 2:
            polled_again.set()
        return 0

    monkeypatch.setattr(worker, "run_once", run_once)
    worker.start()
    try:
        assert polled_again.wait(10), "the idle lane slept through the other lane's work"
    finally:
        assert worker.stop()
