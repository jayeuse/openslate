"""Worker start/stop ownership stays safe around application shutdown."""

import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI

import app.main as main
from app.systems.sandbox.automations.runner import _compare
from app.systems.sandbox.automations.worker import AutomationWorker


def test_test_environment_never_starts_a_background_worker() -> None:
    worker = AutomationWorker(SimpleNamespace(environment="test"))

    worker.start()

    assert not worker.running
    assert worker.stop()


def test_stop_reports_when_a_worker_did_not_join() -> None:
    worker = AutomationWorker(SimpleNamespace(environment="development"))
    worker._thread = SimpleNamespace(join=lambda **_kwargs: None, is_alive=lambda: True)  # type: ignore[assignment]

    assert not worker.stop()


def test_runtime_comparisons_allow_null_equality_without_evaluating_ordering() -> None:
    assert _compare(None, "=", None)
    assert _compare(None, "!=", "value")
    assert not _compare(None, ">", 1)


def test_claim_failure_logs_context_and_increases_the_next_idle_wait(monkeypatch) -> None:
    worker = AutomationWorker(SimpleNamespace(environment="development"))
    log_event = Mock()
    monkeypatch.setattr("app.systems.sandbox.automations.worker.get_engine", Mock())
    monkeypatch.setattr(
        "app.systems.sandbox.automations.worker.enqueue_due_schedules",
        Mock(side_effect=RuntimeError("database unavailable")),
    )
    monkeypatch.setattr("app.systems.sandbox.automations.worker.log_event", log_event)

    assert worker.run_once() == 0

    assert worker._claim_retry_seconds == 2
    assert log_event.call_args.kwargs["reason_code"] == (
        "sandbox_automation_claim_failed_runtimeerror"
    )


def test_claim_retry_delay_caps_and_resets_after_a_successful_claim_pass(monkeypatch) -> None:
    worker = AutomationWorker(SimpleNamespace(environment="development"))
    worker._claim_retry_seconds = 32
    monkeypatch.setattr("app.systems.sandbox.automations.worker.get_engine", Mock())
    monkeypatch.setattr(
        "app.systems.sandbox.automations.worker.enqueue_due_schedules",
        Mock(side_effect=RuntimeError("database unavailable")),
    )

    assert worker.run_once() == 0
    assert worker._claim_retry_seconds == 60

    database = Mock()
    session = Mock()
    session.__enter__ = Mock(return_value=database)  # type: ignore[attr-defined]
    session.__exit__ = Mock(return_value=False)  # type: ignore[attr-defined]
    monkeypatch.setattr(
        "app.systems.sandbox.automations.worker.AuditSession", Mock(return_value=session)
    )
    monkeypatch.setattr("app.systems.sandbox.automations.worker.enqueue_due_schedules", Mock())
    monkeypatch.setattr(
        "app.systems.sandbox.automations.worker.claim_due_events", Mock(return_value=[])
    )

    assert worker.run_once() == 0
    assert worker._claim_retry_seconds == 1


def test_lifespan_keeps_database_pool_when_automation_worker_is_alive(monkeypatch) -> None:
    app = FastAPI()
    app.state.events_listener = SimpleNamespace(start=lambda: None, stop=lambda: None)
    app.state.smtp_outbox_worker = SimpleNamespace(start=lambda: None, stop=lambda: None)
    app.state.automation_worker = SimpleNamespace(start=lambda: None, stop=lambda: False)
    dispose_database = Mock()
    dispose_readiness = Mock()
    monkeypatch.setattr(main, "configure_observability_logging", lambda: None)
    monkeypatch.setattr(main, "dispose_database_resources", dispose_database)
    monkeypatch.setattr(main, "dispose_readiness_resources", dispose_readiness)

    async def exercise() -> None:
        context = main.application_lifespan(app)
        await context.__aenter__()
        await context.__aexit__(None, None, None)

    asyncio.run(exercise())

    dispose_database.assert_not_called()
    dispose_readiness.assert_not_called()
