"""Bounded background worker for published Sandbox triggers."""

from __future__ import annotations

import threading
import time

from app.core.base_model import utc_now
from app.core.config import Settings
from app.core.database.organization_scope import worker_organization
from app.core.database.session import AuditSession, get_engine
from app.core.observability import log_event
from app.systems.manage.workspace.organizations import active_organization_ids
from app.systems.sandbox.record_triggers.execution import (
    ClaimedTriggerEvent,
    claim_due_events,
    mark_claim_failed,
    release_claim,
)
from app.systems.sandbox.record_triggers.outbox import enqueue_due_schedules
from app.systems.sandbox.record_triggers.runner import execute_claim

# Every interval with work, log how many events ran, their mean run time and the longest
# wait from the record change to the run (the automation delay users see).
_METRICS_SECONDS = 10.0


class TriggerWorker:
    """Poll, claim, and execute durable events without sharing sessions."""

    def __init__(self, settings: Settings) -> None:
        self._enabled = settings.environment != "test" or settings.e2e_background_workers
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._running = False
        self._claim_retry_seconds = 1
        self._metrics_started = time.monotonic()
        self._metrics_count = 0
        self._metrics_run_ms = 0
        self._metrics_max_wait_ms = 0

    @property
    def running(self) -> bool:
        return self._running

    def start(self) -> None:
        if not self._enabled or self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="openslate-triggers",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> bool:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=5)
        if thread is not None and thread.is_alive():
            log_event(
                "operational_attention",
                reason_code="sandbox_trigger_shutdown_timeout",
                upstream="sandbox-triggers",
            )
            return False
        self._thread = None
        self._running = False
        return True

    def run_once(self) -> int:
        try:
            organizations = active_organization_ids(get_engine())
        except Exception as error:
            self._claim_failed(error)
            return 0
        processed = 0
        for org_id in organizations:
            with worker_organization(org_id):
                processed += self._run_organization()
            if self._stop.is_set():
                break
        return processed

    def _run_organization(self) -> int:
        claims = self._enqueue_and_claim()
        for index, claim in enumerate(claims):
            if self._stop.is_set():
                self._release(claims[index:])
                break
            self._execute(claim)
        return len(claims)

    def _run(self) -> None:
        self._running = True
        try:
            while not self._stop.is_set():
                processed = self.run_once()
                self._report_metrics()
                if processed == 0:
                    self._stop.wait(self._claim_retry_seconds)
        finally:
            self._running = False

    def _enqueue_and_claim(self) -> list[ClaimedTriggerEvent]:
        try:
            with AuditSession(bind=get_engine()) as db:
                enqueue_due_schedules(db)
                claims = claim_due_events(db)
                db.commit()
                self._claim_retry_seconds = 1
                return claims
        except Exception as error:
            self._claim_failed(error)
            return []

    def _claim_failed(self, error: Exception) -> None:
        self._claim_retry_seconds = min(self._claim_retry_seconds * 2, 60)
        log_event(
            "operational_attention",
            reason_code=f"sandbox_trigger_claim_failed_{type(error).__name__.lower()}",
            upstream="sandbox-triggers",
        )

    def _release(self, claims: list[ClaimedTriggerEvent]) -> None:
        try:
            with AuditSession(bind=get_engine()) as db:
                for claim in claims:
                    release_claim(db, claim)
                db.commit()
        except Exception as error:
            log_event(
                "operational_attention",
                reason_code=f"sandbox_trigger_release_failed_{type(error).__name__.lower()}",
                upstream="sandbox-triggers",
            )

    def _report_metrics(self) -> None:
        if time.monotonic() - self._metrics_started < _METRICS_SECONDS:
            return
        if self._metrics_count:
            log_event(
                "worker_metrics",
                upstream="sandbox-triggers",
                count=self._metrics_count,
                duration_ms=self._metrics_run_ms // self._metrics_count,
                age_ms=self._metrics_max_wait_ms,
            )
        self._metrics_started = time.monotonic()
        self._metrics_count = self._metrics_run_ms = self._metrics_max_wait_ms = 0

    def _execute(self, claim: ClaimedTriggerEvent) -> None:
        if claim.queued_at is not None:
            waited = (utc_now() - claim.queued_at).total_seconds() * 1000
            self._metrics_max_wait_ms = max(self._metrics_max_wait_ms, int(waited))
        started = time.perf_counter()
        try:
            self._run_claim(claim)
        finally:
            self._metrics_count += 1
            self._metrics_run_ms += int((time.perf_counter() - started) * 1000)

    def _run_claim(self, claim: ClaimedTriggerEvent) -> None:
        try:
            with AuditSession(bind=get_engine()) as db:
                if execute_claim(db, claim):
                    db.commit()
                else:
                    db.rollback()
        except Exception:
            log_event(
                "operational_attention",
                reason_code="sandbox_trigger_execution_failed",
                operation_id=claim.id,
                upstream="sandbox-triggers",
            )
            try:
                with AuditSession(bind=get_engine()) as db:
                    if mark_claim_failed(db, claim):
                        log_event(
                            "operational_attention",
                            reason_code="sandbox_trigger_event_failed",
                            operation_id=claim.id,
                            upstream="sandbox-triggers",
                        )
                    db.commit()
            except Exception:
                log_event(
                    "operational_attention",
                    reason_code="sandbox_trigger_retry_failed",
                    operation_id=claim.id,
                    upstream="sandbox-triggers",
                )
