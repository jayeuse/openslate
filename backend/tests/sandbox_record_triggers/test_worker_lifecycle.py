"""Worker start/stop ownership stays safe around application shutdown."""

import asyncio
from types import SimpleNamespace
from unittest.mock import Mock, call

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


def test_test_environment_never_starts_a_background_worker() -> None:
    worker = TriggerWorker(SimpleNamespace(environment="test", e2e_background_workers=False))

    worker.start()

    assert not worker.running
    assert worker.stop()


def test_stop_reports_when_a_worker_did_not_join() -> None:
    worker = TriggerWorker(SimpleNamespace(environment="development"))
    worker._thread = SimpleNamespace(join=lambda **_kwargs: None, is_alive=lambda: True)  # type: ignore[assignment]

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
    worker = TriggerWorker(SimpleNamespace(environment="development"))
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
    worker = TriggerWorker(SimpleNamespace(environment="development"))
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
    worker = TriggerWorker(SimpleNamespace(environment="development"))
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
