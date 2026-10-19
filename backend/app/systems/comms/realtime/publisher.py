"""Bounded best-effort private HTTP publication, never database-atomic delivery."""

import queue
import threading
import time
from collections import Counter
from typing import Any

import httpx
from fastapi import FastAPI
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core import base_model
from app.core.config import Settings
from app.core.database.organization_scope import worker_organization
from app.core.database.session import AuditSession, get_engine
from app.core.observability import log_event
from app.systems.comms.realtime.grants import sweep_expired
from app.systems.comms.realtime.publication import request_events
from app.systems.manage.workspace.organizations import active_organization_ids

BATCH_SIZE = 100
QUEUE_BATCHES = 64


class CommsPublisher:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.queue: queue.Queue[list[dict[str, Any]]] = queue.Queue(QUEUE_BATCHES)
        self.outcomes: Counter[str] = Counter()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is None:
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="comms-publisher", daemon=True)
            self._thread.start()

    def submit(self, events: list[dict[str, Any]]) -> None:
        for start in range(0, len(events), BATCH_SIZE):
            try:
                self.queue.put_nowait(events[start : start + BATCH_SIZE])
            except queue.Full:
                self.outcomes["queue_full"] += 1
                log_event(
                    "operational_attention",
                    reason_code="comms_publish_queue_full",
                    upstream="realtime",
                )

    def deliver(self, client: httpx.Client, batch: list[dict[str, Any]]) -> None:
        client.cookies.clear()
        try:
            with client.stream(
                "POST",
                self.settings.realtime_publish_url,
                json={"messages": batch},
                headers={"apikey": self.settings.supabase_secret_key.get_secret_value()},
            ) as response:
                outcome = (
                    "accepted"
                    if response.status_code == 202
                    else ("rate_limited" if response.status_code == 429 else "refused")
                )
        except httpx.HTTPError:
            outcome = "transport_failed"
        self.outcomes[outcome] += 1
        if outcome != "accepted":
            # Never include upstream bodies, headers, URLs, keys or exception strings.
            log_event(
                "operational_attention", reason_code=f"comms_publish_{outcome}", upstream="realtime"
            )

    def _sweep(self) -> None:
        try:
            engine = get_engine()
            for org_id in active_organization_ids(engine):
                with worker_organization(org_id), AuditSession(engine) as db:
                    sweep_expired(db, base_model.utc_now())
                    db.commit()
        except Exception:
            log_event(
                "operational_attention", reason_code="comms_grant_sweep_failed", upstream="realtime"
            )

    def _run(self) -> None:
        next_sweep = time.monotonic() + 60
        with httpx.Client(
            timeout=1.0,
            follow_redirects=False,
            trust_env=False,
            limits=httpx.Limits(max_connections=1, max_keepalive_connections=1),
        ) as client:
            while not self._stop.is_set():
                try:
                    batch = self.queue.get(timeout=0.25)
                except queue.Empty:
                    batch = None
                if batch is not None:
                    try:
                        self.deliver(client, batch)
                    finally:
                        self.queue.task_done()
                if time.monotonic() >= next_sweep:
                    self._sweep()  # Sessions close before the next HTTP operation.
                    next_sweep = time.monotonic() + 60

    def stop(self) -> bool:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            if self._thread.is_alive():
                log_event(
                    "operational_attention",
                    reason_code="comms_publisher_shutdown_timeout",
                    upstream="realtime",
                )
                return False
            self._thread = None
        return True


class CommsPublicationMiddleware:
    """Submit only after the response and all request dependency finalizers finish."""

    def __init__(self, app: ASGIApp, publisher: CommsPublisher) -> None:
        self.app, self.publisher = app, publisher

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        events: list[dict[str, Any]] = []
        token = request_events.set(events)
        sent = False

        async def observe(message: Message) -> None:
            nonlocal sent
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                sent = True

        try:
            await self.app(scope, receive, observe)
        finally:
            request_events.reset(token)
            if sent:
                self.publisher.submit(events)


def install_publication(app: FastAPI, settings: Settings) -> None:
    """Register last: the publication boundary must wrap all response middleware."""
    app.state.comms_publisher = CommsPublisher(settings)
    app.add_middleware(CommsPublicationMiddleware, publisher=app.state.comms_publisher)
