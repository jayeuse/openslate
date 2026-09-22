"""Bounded background worker for published Sandbox automations."""

from __future__ import annotations

import threading

from app.core.config import Settings
from app.core.database.session import AuditSession, get_engine
from app.core.observability import log_event
from app.systems.sandbox.automations.execution import (
    ClaimedAutomationEvent,
    claim_due_events,
    mark_claim_failed,
    release_claim,
)
from app.systems.sandbox.automations.outbox import enqueue_due_schedules
from app.systems.sandbox.automations.runner import execute_claim


class AutomationWorker:
    """Poll, claim, and execute durable events without sharing sessions."""

    def __init__(self, settings: Settings) -> None:
        self._enabled = settings.environment != "test"
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._running = False
        self._claim_retry_seconds = 1

    @property
    def running(self) -> bool:
        return self._running

    def start(self) -> None:
        if not self._enabled or self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="openslate-automations",
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
                reason_code="sandbox_automation_shutdown_timeout",
                upstream="sandbox-automations",
            )
            return False
        self._thread = None
        self._running = False
        return True

    def run_once(self) -> int:
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
                if processed == 0:
                    self._stop.wait(self._claim_retry_seconds)
        finally:
            self._running = False

    def _enqueue_and_claim(self) -> list[ClaimedAutomationEvent]:
        try:
            with AuditSession(bind=get_engine()) as db:
                enqueue_due_schedules(db)
                claims = claim_due_events(db)
                db.commit()
                self._claim_retry_seconds = 1
                return claims
        except Exception as error:
            self._claim_retry_seconds = min(self._claim_retry_seconds * 2, 60)
            log_event(
                "operational_attention",
                reason_code=f"sandbox_automation_claim_failed_{type(error).__name__.lower()}",
                upstream="sandbox-automations",
            )
            return []

    def _release(self, claims: list[ClaimedAutomationEvent]) -> None:
        try:
            with AuditSession(bind=get_engine()) as db:
                for claim in claims:
                    release_claim(db, claim)
                db.commit()
        except Exception as error:
            log_event(
                "operational_attention",
                reason_code=f"sandbox_automation_release_failed_{type(error).__name__.lower()}",
                upstream="sandbox-automations",
            )

    def _execute(self, claim: ClaimedAutomationEvent) -> None:
        try:
            with AuditSession(bind=get_engine()) as db:
                if execute_claim(db, claim):
                    db.commit()
                else:
                    db.rollback()
        except Exception:
            log_event(
                "operational_attention",
                reason_code="sandbox_automation_execution_failed",
                operation_id=claim.id,
                upstream="sandbox-automations",
            )
            try:
                with AuditSession(bind=get_engine()) as db:
                    if mark_claim_failed(db, claim):
                        log_event(
                            "operational_attention",
                            reason_code="sandbox_automation_event_failed",
                            operation_id=claim.id,
                            upstream="sandbox-automations",
                        )
                    db.commit()
            except Exception:
                log_event(
                    "operational_attention",
                    reason_code="sandbox_automation_retry_failed",
                    operation_id=claim.id,
                    upstream="sandbox-automations",
                )
