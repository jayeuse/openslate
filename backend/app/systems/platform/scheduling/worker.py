"""Bounded process-local polling for durable Report and Board work."""

from __future__ import annotations

import threading
import time
from datetime import datetime
from uuid import UUID

from app.core.config import Settings
from app.core.database.session import get_engine
from app.core.observability import log_event
from app.systems.platform.scheduling.execution import execute_due_report_runs
from app.systems.platform.scheduling.post_execution import (
    execute_due_post_publications,
)
from app.systems.platform.scheduling.reminder_execution import execute_due_reminders

_POLL_SECONDS = 1
_MAX_RETRY_SECONDS = 60
_SHUTDOWN_SECONDS = 5


class ReportSchedulingWorker:
    """Run both bounded work kinds in one thread without sharing request sessions."""

    def __init__(self, settings: Settings) -> None:
        self._enabled = settings.environment != "test" or settings.e2e_background_workers
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._running = False
        self._retry_seconds = _POLL_SECONDS
        self._failure_reported = False
        self._post_retry_seconds = _POLL_SECONDS
        self._post_failure_reported = False
        self._reminder_retry_seconds = _POLL_SECONDS
        self._reminder_failure_reported = False

    @property
    def running(self) -> bool:
        return self._running

    @property
    def retry_seconds(self) -> int:
        return self._retry_seconds

    @property
    def post_retry_seconds(self) -> int:
        return self._post_retry_seconds

    @property
    def reminder_retry_seconds(self) -> int:
        return self._reminder_retry_seconds

    def start(self) -> None:
        if not self._enabled or self._thread is not None:
            return
        self._stop.clear()
        thread = threading.Thread(
            target=self._run,
            name="openslate-scheduled-work",
            daemon=True,
        )
        thread.start()
        self._thread = thread

    def stop(self) -> bool:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=_SHUTDOWN_SECONDS)
            if thread.is_alive():
                log_event(
                    "operational_attention",
                    reason_code="report_scheduling_shutdown_timeout",
                    upstream="report-scheduling",
                )
                return False
        self._thread = None
        self._running = False
        return True

    def run_once(self, *, now: datetime | None = None) -> list[UUID]:
        """Poll both kinds; retain the Report run IDs as this method's result."""

        return self._poll(now=now, reports=True, posts=True, reminders=True)

    def _poll(
        self, *, now: datetime | None, reports: bool, posts: bool, reminders: bool
    ) -> list[UUID]:
        completed: list[UUID] = []
        if reports:
            completed = self._poll_reports(now=now)
        if posts and not self._stop.is_set():
            self._poll_posts(now=now)
        if reminders and not self._stop.is_set():
            self._poll_reminders(now=now)
        return completed

    def _poll_reports(self, *, now: datetime | None) -> list[UUID]:
        try:
            completed = execute_due_report_runs(get_engine(), now=now)
        except Exception:
            self._retry_seconds = min(self._retry_seconds * 2, _MAX_RETRY_SECONDS)
            if not self._failure_reported:
                log_event(
                    "operational_attention",
                    reason_code="report_scheduling_poll_failed",
                    upstream="report-scheduling",
                )
                self._failure_reported = True
            return []
        self._retry_seconds = _POLL_SECONDS
        self._failure_reported = False
        return completed

    def _poll_posts(self, *, now: datetime | None) -> None:
        try:
            execute_due_post_publications(get_engine(), now=now)
        except Exception:
            self._post_retry_seconds = min(self._post_retry_seconds * 2, _MAX_RETRY_SECONDS)
            if not self._post_failure_reported:
                log_event(
                    "operational_attention",
                    reason_code="post_scheduling_poll_failed",
                    upstream="board-posts",
                )
                self._post_failure_reported = True
            return
        self._post_retry_seconds = _POLL_SECONDS
        self._post_failure_reported = False

    def _poll_reminders(self, *, now: datetime | None) -> None:
        try:
            execute_due_reminders(get_engine(), now=now)
        except Exception:
            self._reminder_retry_seconds = min(self._reminder_retry_seconds * 2, _MAX_RETRY_SECONDS)
            if not self._reminder_failure_reported:
                log_event(
                    "operational_attention",
                    reason_code="event_reminder_poll_failed",
                    upstream="board-events",
                )
                self._reminder_failure_reported = True
            return
        self._reminder_retry_seconds = _POLL_SECONDS
        self._reminder_failure_reported = False

    def _run(self) -> None:
        self._running = True
        next_report_poll = time.monotonic()
        next_post_poll = next_report_poll
        next_reminder_poll = next_report_poll
        try:
            while not self._stop.is_set():
                current = time.monotonic()
                reports_due = current >= next_report_poll
                posts_due = current >= next_post_poll
                reminders_due = current >= next_reminder_poll
                self._poll(
                    now=None,
                    reports=reports_due,
                    posts=posts_due,
                    reminders=reminders_due,
                )
                completed_at = time.monotonic()
                if reports_due:
                    next_report_poll = completed_at + self._retry_seconds
                if posts_due:
                    next_post_poll = completed_at + self._post_retry_seconds
                if reminders_due:
                    next_reminder_poll = completed_at + self._reminder_retry_seconds
                wait_seconds = max(
                    0.0,
                    min(next_report_poll, next_post_poll, next_reminder_poll) - time.monotonic(),
                )
                self._stop.wait(wait_seconds)
        finally:
            self._running = False
