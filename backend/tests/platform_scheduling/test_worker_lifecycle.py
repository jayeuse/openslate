"""Scheduled Report and Board work share one worker and pool lifetime."""

import asyncio
import threading
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock, call

import pytest
from fastapi import FastAPI
from sqlalchemy import func, select

import app.main as main
from app.core.database.session import AuditSession
from app.systems.openview.reports.models import ReportRun
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork, WorkState

pytest_plugins = ("tests.platform_scheduling.test_execution",)
NOW = datetime(2026, 1, 1, 12, tzinfo=UTC)


def test_test_environment_does_not_start_report_thread() -> None:
    from app.systems.platform.scheduling.worker import ReportSchedulingWorker

    worker = ReportSchedulingWorker(
        SimpleNamespace(environment="test", e2e_background_workers=False)
    )
    worker.start()
    worker.start()

    assert not worker.running
    assert worker.stop()
    assert worker.stop()


def test_runtime_start_and_stop_are_idempotent(monkeypatch) -> None:
    from app.systems.platform.scheduling.worker import ReportSchedulingWorker

    worker = ReportSchedulingWorker(SimpleNamespace(environment="development"))
    entered = threading.Event()
    calls = Mock()

    def run() -> None:
        calls()
        entered.set()
        worker._stop.wait()

    monkeypatch.setattr(worker, "_run", run)
    worker.start()
    assert entered.wait(timeout=1)
    worker.start()
    assert worker.stop()
    assert worker.stop()
    calls.assert_called_once_with()


def test_worker_poll_reuses_process_engine_and_backs_off_quietly(monkeypatch) -> None:
    from app.systems.platform.scheduling import worker as module

    worker = module.ReportSchedulingWorker(SimpleNamespace(environment="development"))
    engine = object()
    run_id = object()
    executor = Mock(
        side_effect=[RuntimeError("database offline"), RuntimeError("offline"), [run_id]]
    )
    logger = Mock()
    monkeypatch.setattr(module, "get_engine", lambda: engine)
    monkeypatch.setattr(module, "execute_due_report_runs", executor)
    monkeypatch.setattr(
        module, "execute_due_post_publications", Mock(return_value=[]), raising=False
    )
    monkeypatch.setattr(module, "execute_due_reminders", Mock(return_value=[]))
    monkeypatch.setattr(module, "log_event", logger)

    assert worker.run_once(now=NOW) == []
    assert worker.retry_seconds == 2
    assert worker.run_once(now=NOW) == []
    assert worker.retry_seconds == 4
    assert logger.call_count == 1
    assert worker.run_once(now=NOW) == [run_id]
    assert worker.retry_seconds == 1
    assert executor.call_args_list == [call(engine, now=NOW)] * 3


def test_poll_retry_delay_caps_at_sixty_seconds(monkeypatch) -> None:
    from app.systems.platform.scheduling import worker as module

    worker = module.ReportSchedulingWorker(SimpleNamespace(environment="development"))
    monkeypatch.setattr(module, "get_engine", Mock())
    monkeypatch.setattr(
        module, "execute_due_report_runs", Mock(side_effect=RuntimeError("offline"))
    )
    monkeypatch.setattr(
        module, "execute_due_post_publications", Mock(return_value=[]), raising=False
    )
    monkeypatch.setattr(module, "execute_due_reminders", Mock(return_value=[]))
    monkeypatch.setattr(module, "log_event", Mock())

    for _ in range(10):
        assert worker.run_once() == []

    assert worker.retry_seconds == 60


def test_post_poll_failure_does_not_block_report_poll(monkeypatch) -> None:
    from app.systems.platform.scheduling import worker as module

    worker = module.ReportSchedulingWorker(SimpleNamespace(environment="development"))
    engine = object()
    report_id = object()
    reports = Mock(return_value=[report_id])
    posts = Mock(side_effect=RuntimeError("post database fault"))
    logger = Mock()
    monkeypatch.setattr(module, "get_engine", lambda: engine)
    monkeypatch.setattr(module, "execute_due_report_runs", reports)
    monkeypatch.setattr(module, "execute_due_post_publications", posts, raising=False)
    monkeypatch.setattr(module, "execute_due_reminders", Mock(return_value=[]))
    monkeypatch.setattr(module, "log_event", logger)

    assert worker.run_once(now=NOW) == [report_id]
    assert worker.retry_seconds == 1
    assert worker.post_retry_seconds == 2
    assert worker.run_once(now=NOW) == [report_id]
    assert worker.post_retry_seconds == 4
    assert reports.call_args_list == [call(engine, now=NOW)] * 2
    assert posts.call_args_list == [call(engine, now=NOW)] * 2
    assert logger.call_count == 1
    assert logger.call_args.kwargs["reason_code"] == "post_scheduling_poll_failed"


def test_report_poll_failure_does_not_block_post_poll(monkeypatch) -> None:
    from app.systems.platform.scheduling import worker as module

    worker = module.ReportSchedulingWorker(SimpleNamespace(environment="development"))
    engine = object()
    publication_id = object()
    reports = Mock(side_effect=RuntimeError("report database fault"))
    posts = Mock(return_value=[publication_id])
    monkeypatch.setattr(module, "get_engine", lambda: engine)
    monkeypatch.setattr(module, "execute_due_report_runs", reports)
    monkeypatch.setattr(module, "execute_due_post_publications", posts, raising=False)
    monkeypatch.setattr(module, "execute_due_reminders", Mock(return_value=[]))
    monkeypatch.setattr(module, "log_event", Mock())

    assert worker.run_once(now=NOW) == []
    assert worker.retry_seconds == 2
    assert worker.post_retry_seconds == 1
    reports.assert_called_once_with(engine, now=NOW)
    posts.assert_called_once_with(engine, now=NOW)


def test_reminder_poll_failure_does_not_block_report_or_post(monkeypatch) -> None:
    from app.systems.platform.scheduling import worker as module

    worker = module.ReportSchedulingWorker(SimpleNamespace(environment="development"))
    engine = object()
    report_id = object()
    reports = Mock(return_value=[report_id])
    posts = Mock(return_value=[])
    reminders = Mock(side_effect=[RuntimeError("reminder unavailable"), []])
    logger = Mock()
    monkeypatch.setattr(module, "get_engine", lambda: engine)
    monkeypatch.setattr(module, "execute_due_report_runs", reports)
    monkeypatch.setattr(module, "execute_due_post_publications", posts)
    monkeypatch.setattr(module, "execute_due_reminders", reminders)
    monkeypatch.setattr(module, "log_event", logger)

    assert worker.run_once(now=NOW) == [report_id]
    assert worker.reminder_retry_seconds == 2
    assert logger.call_count == 1
    assert logger.call_args.kwargs["reason_code"] == "event_reminder_poll_failed"
    assert worker.run_once(now=NOW) == [report_id]
    assert worker.reminder_retry_seconds == 1
    assert reports.call_args_list == [call(engine, now=NOW)] * 2
    assert posts.call_args_list == [call(engine, now=NOW)] * 2
    assert reminders.call_args_list == [call(engine, now=NOW)] * 2


def test_post_backoff_does_not_delay_healthy_report_polls(monkeypatch) -> None:
    from app.systems.platform.scheduling import worker as module

    worker = module.ReportSchedulingWorker(SimpleNamespace(environment="development"))
    clock = SimpleNamespace(value=0.0)
    report_polls: list[float] = []
    post_polls: list[float] = []

    class ControlledStop:
        def is_set(self) -> bool:
            return clock.value >= 3

        def wait(self, seconds: float) -> bool:
            assert seconds > 0
            clock.value += seconds
            return self.is_set()

    worker._stop = ControlledStop()
    monkeypatch.setattr(
        module, "time", SimpleNamespace(monotonic=lambda: clock.value), raising=False
    )
    monkeypatch.setattr(module, "get_engine", lambda: object())
    monkeypatch.setattr(
        module,
        "execute_due_report_runs",
        lambda *_args, **_kwargs: report_polls.append(clock.value) or [],
    )

    def fail_post(*_args, **_kwargs):
        post_polls.append(clock.value)
        raise RuntimeError("temporary post fault")

    monkeypatch.setattr(module, "execute_due_post_publications", fail_post, raising=False)
    monkeypatch.setattr(module, "execute_due_reminders", Mock(return_value=[]))
    monkeypatch.setattr(module, "log_event", Mock())

    worker._run()

    assert report_polls == [0, 1, 2]
    assert post_polls == [0, 2]
    assert not worker.running


def test_stop_timeout_retains_thread_and_prevents_database_disposal(monkeypatch) -> None:
    from app.systems.platform.scheduling import worker as module

    worker = module.ReportSchedulingWorker(SimpleNamespace(environment="development"))
    thread = Mock()
    thread.is_alive.side_effect = [True, False]
    worker._thread = thread
    logger = Mock()
    monkeypatch.setattr(module, "log_event", logger)

    assert not worker.stop()
    assert worker._thread is thread
    assert thread.join.call_args.kwargs["timeout"] is not None
    assert logger.call_args.kwargs["reason_code"] == "report_scheduling_shutdown_timeout"
    assert worker.stop()
    assert worker._thread is None


def test_lifespan_joins_report_worker_before_database_disposal(monkeypatch) -> None:
    order: list[str] = []
    app = FastAPI()
    app.state.events_listener = SimpleNamespace(
        start=lambda: order.append("events_start"), stop=lambda: order.append("events_stop")
    )
    app.state.smtp_outbox_worker = SimpleNamespace(
        start=lambda: order.append("smtp_start"), stop=lambda: order.append("smtp_stop")
    )
    app.state.trigger_worker = SimpleNamespace(
        start=lambda: order.append("trigger_start"),
        stop=lambda: order.append("trigger_stop") or True,
    )
    app.state.report_scheduling_worker = SimpleNamespace(
        start=lambda: order.append("report_start"),
        stop=lambda: order.append("report_stop") or True,
    )
    monkeypatch.setattr(main, "configure_observability_logging", lambda: None)
    monkeypatch.setattr(main, "instance_target_for_process", lambda *_args: None)
    monkeypatch.setattr(
        main, "dispose_readiness_resources", lambda: order.append("readiness_dispose")
    )
    monkeypatch.setattr(
        main, "dispose_database_resources", lambda: order.append("database_dispose")
    )

    async def exercise() -> None:
        async with main.application_lifespan(app):
            pass

    asyncio.run(exercise())

    assert order.index("report_start") < order.index("report_stop")
    assert order.index("report_stop") < order.index("database_dispose")


def test_failed_report_thread_start_still_cleans_up_lifespan(monkeypatch) -> None:
    from app.systems.platform.scheduling import worker as module

    order: list[str] = []
    app = FastAPI()
    app.state.events_listener = SimpleNamespace(
        start=lambda: None, stop=lambda: order.append("events_stop")
    )
    app.state.smtp_outbox_worker = SimpleNamespace(
        start=lambda: None, stop=lambda: order.append("smtp_stop")
    )
    app.state.trigger_worker = SimpleNamespace(
        start=lambda: None, stop=lambda: order.append("trigger_stop") or True
    )
    app.state.report_scheduling_worker = module.ReportSchedulingWorker(
        SimpleNamespace(environment="development")
    )
    failed_thread = Mock()
    failed_thread.start.side_effect = RuntimeError("thread startup failed")
    failed_thread.join.side_effect = RuntimeError("cannot join an unstarted thread")
    monkeypatch.setattr(
        module, "threading", SimpleNamespace(Thread=lambda **_kwargs: failed_thread)
    )
    monkeypatch.setattr(main, "configure_observability_logging", lambda: None)
    monkeypatch.setattr(main, "instance_target_for_process", lambda *_args: None)
    monkeypatch.setattr(main, "dispose_readiness_resources", lambda: order.append("readiness"))
    monkeypatch.setattr(main, "dispose_database_resources", lambda: order.append("database"))

    async def exercise() -> None:
        async with main.application_lifespan(app):
            pass

    with pytest.raises(RuntimeError, match="thread startup failed"):
        asyncio.run(exercise())

    failed_thread.join.assert_not_called()
    assert order == ["trigger_stop", "events_stop", "readiness", "database"]


def test_lifespan_does_not_dispose_pool_when_report_worker_remains_alive(monkeypatch) -> None:
    app = FastAPI()
    app.state.events_listener = SimpleNamespace(start=lambda: None, stop=lambda: None)
    app.state.smtp_outbox_worker = SimpleNamespace(start=lambda: None, stop=lambda: None)
    app.state.trigger_worker = SimpleNamespace(start=lambda: None, stop=lambda: True)
    app.state.report_scheduling_worker = SimpleNamespace(start=lambda: None, stop=lambda: False)
    dispose_database = Mock()
    dispose_readiness = Mock()
    logger = Mock()
    monkeypatch.setattr(main, "configure_observability_logging", lambda: None)
    monkeypatch.setattr(main, "instance_target_for_process", lambda *_args: None)
    monkeypatch.setattr(main, "dispose_database_resources", dispose_database)
    monkeypatch.setattr(main, "dispose_readiness_resources", dispose_readiness)
    monkeypatch.setattr(main, "log_event", logger)

    async def exercise() -> None:
        async with main.application_lifespan(app):
            pass

    asyncio.run(exercise())

    dispose_database.assert_not_called()
    dispose_readiness.assert_not_called()
    assert logger.call_args.kwargs["reason_code"] == "report_scheduling_shutdown_incomplete"


@pytest.mark.integration
def test_due_report_worker_poll_commits_one_run_work_and_notification(
    scheduled_report, monkeypatch
):
    from app.systems.platform.scheduling import worker as module

    subject = scheduled_report
    worker = module.ReportSchedulingWorker(SimpleNamespace(environment="development"))
    monkeypatch.setattr(module, "get_engine", lambda: subject.runtime_engine)

    assert len(worker.run_once(now=NOW)) == 1
    assert worker.run_once(now=NOW) == []
    with AuditSession(subject.owner_engine) as db:
        work = db.scalar(select(ScheduledWork).where(ScheduledWork.report_id == subject.report_id))
        assert work is not None and work.state == WorkState.SUCCEEDED
        assert (
            db.scalar(
                select(func.count())
                .select_from(ReportRun)
                .where(ReportRun.report_id == subject.report_id)
            )
            == 1
        )
        assert (
            db.scalar(
                select(func.count())
                .select_from(InAppNotification)
                .where(InAppNotification.work_id == work.id)
            )
            # Every module reader at run time gets one notification.
            == 3
        )
