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
    MAX_CLAIM_BATCH,
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
# Shutdown waits this long in total for every lane to finish its current event.
_STOP_SECONDS = 5.0


class TriggerWorker:
    """Poll, claim, and execute durable events on several lanes without sharing sessions.

    Each lane is one thread that runs the whole loop: it visits every organization,
    claims a small batch from the shared queue (FOR UPDATE SKIP LOCKED), and runs it.
    Lanes start at different organizations, and the batch is split between lanes, so a
    burst in one organization, or one module, spreads over every lane. The claim keeps
    one record's events in order. Only the first lane queues due schedules. A lane that
    ran events wakes idle lanes: its runs may have queued follow-up events or freed a
    record's next event, which an idle lane would otherwise leave for its next poll.
    """

    def __init__(self, settings: Settings) -> None:
        self._enabled = settings.environment != "test" or settings.e2e_background_workers
        self._lanes = settings.trigger_workers
        self._claim_limit = max(1, MAX_CLAIM_BATCH // self._lanes)
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._lock = threading.Lock()
        self._wake = threading.Condition()
        self._work_generation = 0
        self._active_lanes = 0
        self._claim_retry_seconds = 1
        self._metrics_started = time.monotonic()
        self._metrics_count = 0
        self._metrics_run_ms = 0
        self._metrics_max_wait_ms = 0

    @property
    def running(self) -> bool:
        return self._active_lanes > 0

    def start(self) -> None:
        if not self._enabled or self._threads:
            return
        self._stop.clear()
        self._threads = [
            threading.Thread(
                target=self._run,
                args=(lane,),
                name=f"openslate-triggers-{lane}",
                daemon=True,
            )
            for lane in range(self._lanes)
        ]
        for thread in self._threads:
            thread.start()

    def stop(self) -> bool:
        self._stop.set()
        with self._wake:
            self._wake.notify_all()
        deadline = time.monotonic() + _STOP_SECONDS
        for thread in self._threads:
            thread.join(timeout=max(0.0, deadline - time.monotonic()))
        if any(thread.is_alive() for thread in self._threads):
            log_event(
                "operational_attention",
                reason_code="sandbox_trigger_shutdown_timeout",
                upstream="sandbox-triggers",
            )
            return False
        self._threads = []
        return True

    def run_once(self, lane: int = 0) -> int:
        try:
            organizations = active_organization_ids(get_engine())
        except Exception as error:
            self._claim_failed(error)
            return 0
        if organizations:
            first = lane % len(organizations)
            organizations = organizations[first:] + organizations[:first]
        processed = 0
        for org_id in organizations:
            with worker_organization(org_id):
                processed += self._run_organization(lane)
            if self._stop.is_set():
                break
        return processed

    def _run_organization(self, lane: int) -> int:
        claims = self._enqueue_and_claim(lane)
        for index, claim in enumerate(claims):
            if self._stop.is_set():
                self._release(claims[index:])
                break
            self._execute(claim)
        return len(claims)

    def _run(self, lane: int) -> None:
        with self._lock:
            self._active_lanes += 1
        try:
            while not self._stop.is_set():
                with self._wake:
                    seen = self._work_generation
                processed = self.run_once(lane)
                self._report_metrics()
                with self._wake:
                    if processed:
                        self._work_generation += 1
                        self._wake.notify_all()
                    elif seen == self._work_generation and not self._stop.is_set():
                        self._wake.wait(self._claim_retry_seconds)
        finally:
            with self._lock:
                self._active_lanes -= 1

    def _enqueue_and_claim(self, lane: int = 0) -> list[ClaimedTriggerEvent]:
        try:
            with AuditSession(bind=get_engine()) as db:
                if lane == 0:
                    enqueue_due_schedules(db)
                claims = claim_due_events(db, limit=self._claim_limit)
                db.commit()
                with self._lock:
                    self._claim_retry_seconds = 1
                return claims
        except Exception as error:
            self._claim_failed(error)
            return []

    def _claim_failed(self, error: Exception) -> None:
        with self._lock:
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
        """Log one line for every lane together, once per interval."""

        with self._lock:
            if time.monotonic() - self._metrics_started < _METRICS_SECONDS:
                return
            count, run_ms, max_wait_ms = (
                self._metrics_count,
                self._metrics_run_ms,
                self._metrics_max_wait_ms,
            )
            self._metrics_started = time.monotonic()
            self._metrics_count = self._metrics_run_ms = self._metrics_max_wait_ms = 0
        if count:
            log_event(
                "worker_metrics",
                upstream="sandbox-triggers",
                count=count,
                duration_ms=run_ms // count,
                age_ms=max_wait_ms,
            )

    def _execute(self, claim: ClaimedTriggerEvent) -> None:
        waited = 0
        if claim.queued_at is not None:
            waited = int((utc_now() - claim.queued_at).total_seconds() * 1000)
        started = time.perf_counter()
        try:
            self._run_claim(claim)
        finally:
            run_ms = int((time.perf_counter() - started) * 1000)
            with self._lock:
                self._metrics_max_wait_ms = max(self._metrics_max_wait_ms, waited)
                self._metrics_count += 1
                self._metrics_run_ms += run_ms

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
