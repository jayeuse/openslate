"""Post-commit PostgreSQL invalidation publication.

While the API runs, one publisher thread per process sends every committed transaction's
invalidations on one long-lived connection per database, so a commit never opens a
connection. A lost publish (a full queue, a failed connect or statement) becomes one
coalesced ``resync`` for that database, so open browsers refetch instead of missing the
update. A process without a running publisher (operations, CLI, tests outside the
lifespan) publishes synchronously on one connection per commit.
"""

import logging
import queue
import threading
import time
from collections.abc import Iterable
from dataclasses import dataclass, replace
from typing import Any
from uuid import UUID

import psycopg

from app.core.config import get_settings
from app.core.observability import failure_cause, log_event
from app.systems.platform.events.hub import CHANNEL, _psycopg_url
from app.systems.platform.events.models import InvalidationEvent, resync_event

MAX_INVALIDATIONS_PER_COMMIT = 64
QUEUE_SIZE = 1024
_NOTIFY = "SELECT pg_notify(%s, %s)"
_IDLE_SECONDS = 0.25
_RETRY_SECONDS = 0.25
_MAX_RETRY_SECONDS = 5.0
_SHUTDOWN_JOIN_SECONDS = 2.0

_active_lock = threading.Lock()
_active: "InvalidationPublisher | None" = None


def _bounded(events: Iterable[InvalidationEvent]) -> tuple[InvalidationEvent, ...]:
    """Deduplicate one transaction's invalidations and cap what one commit may send."""

    unique_events = tuple(dict.fromkeys(events))
    public_events = tuple(event for event in unique_events if event.recipient_id is None)
    private_events = tuple(event for event in unique_events if event.recipient_id is not None)
    if len(public_events) > MAX_INVALIDATIONS_PER_COMMIT:
        public_events = (resync_event(),)
    if len(private_events) > MAX_INVALIDATIONS_PER_COMMIT:
        # Recipient-specific invalidations are best effort; never turn them into
        # a resync signal visible to another recipient.
        private_events = ()
    return public_events + private_events


def _notify(connection: Any, events: tuple[InvalidationEvent, ...]) -> None:
    """Route account events to their memberships' organizations and NOTIFY each one."""

    account_ids = {
        event.account_id or event.entity_id
        for event in events
        if event.org_id is None
        and event.recipient_id is None
        and (event.account_id is not None or event.entity == "users")
    } - {None}
    organizations: dict[UUID, list[UUID]] = {}
    if account_ids:
        for account_id, org_id in connection.execute(
            "SELECT user_id, org_id FROM public.memberships WHERE user_id = ANY(%s)",
            (list(account_ids),),
        ).fetchall():
            organizations.setdefault(account_id, []).append(org_id)
    for event in events:
        account_id = event.account_id or (
            event.entity_id if event.entity == "users" and event.org_id is None else None
        )
        routed = (
            tuple(
                replace(event, org_id=org_id, account_id=None)
                for org_id in organizations.get(account_id, [])
            )
            if account_id is not None and event.org_id is None
            else (event,)
        )
        for invalidation in routed:
            connection.execute(_NOTIFY, (CHANNEL, invalidation.to_transport_json()))


def _connect(database_url: str) -> Any:
    settings = get_settings()
    return psycopg.connect(
        _psycopg_url(database_url),
        autocommit=True,
        connect_timeout=settings.database_connect_timeout_seconds,
        options=f"-c statement_timeout={settings.database_statement_timeout_ms}",
    )


def _log_failure(reason_code: str, cause: str) -> None:
    log_event(
        "realtime_invalidation_failure",
        level=logging.WARNING,
        reason_code=reason_code,
        upstream="postgresql",
        cause=cause,
    )


@dataclass(frozen=True, slots=True)
class _Commit:
    events: tuple[InvalidationEvent, ...]
    database_url: str


class InvalidationPublisher:
    """Own the process publisher thread, its bounded queue and its connections."""

    def __init__(self, *, queue_size: int = QUEUE_SIZE) -> None:
        self._queue: queue.Queue[_Commit] = queue.Queue(queue_size)
        self._state = threading.Condition()
        self._unfinished = 0
        # Database URL -> monotonic time its pending resync may be attempted.
        self._resync_due: dict[str, float] = {}
        self._retry_delays: dict[str, float] = {}
        self._connections: dict[str, Any] = {}  # Publisher thread only.
        self._stopping = False
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        """Start the thread and make this the process publisher."""

        global _active
        with self._state:
            if self._thread is None or not self._thread.is_alive():
                self._stopping = False
                self._thread = threading.Thread(
                    target=self._run,
                    name="openslate-invalidations",
                    daemon=True,
                )
                self._thread.start()
        with _active_lock:
            _active = self

    def enqueue(self, events: tuple[InvalidationEvent, ...], database_url: str) -> bool:
        """Queue one commit; False only when this publisher is stopping."""

        with self._state:
            if self._stopping:
                return False
            try:
                self._queue.put_nowait(_Commit(events, database_url))
            except queue.Full:
                first_loss = database_url not in self._resync_due
                self._resync_due.setdefault(database_url, 0.0)
            else:
                self._unfinished += 1
                return True
        if first_loss:
            _log_failure("publish_queue_full", "queue_full")
        return True

    def drain(self, timeout: float) -> bool:
        """Wait until every queued commit and pending resync was sent."""

        with self._state:
            return self._state.wait_for(
                lambda: self._unfinished == 0 and not self._resync_due,
                timeout,
            )

    def stop(self) -> bool:
        """Send what is queued, close the connections and join within a bound."""

        global _active
        with _active_lock:
            if _active is self:
                _active = None
        with self._state:
            self._stopping = True
            thread = self._thread
        if thread is None:
            return True
        thread.join(timeout=_SHUTDOWN_JOIN_SECONDS)
        if thread.is_alive():
            _log_failure("publisher_shutdown_timeout", "shutdown_timeout")
            return False
        self._thread = None
        return True

    def _run(self) -> None:
        try:
            while True:
                for database_url in self._pending_resyncs():
                    self._send_resync(database_url)
                try:
                    commit = self._queue.get(timeout=_IDLE_SECONDS)
                except queue.Empty:
                    with self._state:
                        if self._stopping and self._unfinished == 0:
                            break
                    continue
                try:
                    self._deliver(commit)
                finally:
                    with self._state:
                        self._unfinished -= 1
                        self._state.notify_all()
            for database_url in self._pending_resyncs(due_only=False):
                self._send_resync(database_url, force=True)
        finally:
            for database_url in tuple(self._connections):
                self._close(database_url)

    def _pending_resyncs(self, *, due_only: bool = True) -> tuple[str, ...]:
        now = time.monotonic()
        with self._state:
            return tuple(url for url, due in self._resync_due.items() if not due_only or due <= now)

    def _deliver(self, commit: _Commit) -> None:
        database_url = commit.database_url
        with self._state:
            covered = database_url in self._resync_due
        if covered:
            # A pending resync makes every open browser refetch, which covers this commit.
            self._send_resync(database_url)
            return
        try:
            _notify(self._connection(database_url), commit.events)
        except Exception as error:  # Thread boundary: a lost publish becomes a resync.
            self._close(database_url)
            _log_failure("publish_failed", failure_cause(error))
            with self._state:
                self._resync_due[database_url] = 0.0
            self._send_resync(database_url)

    def _send_resync(self, database_url: str, *, force: bool = False) -> None:
        with self._state:
            due = self._resync_due.get(database_url)
        if due is None or (not force and due > time.monotonic()):
            return
        try:
            self._connection(database_url).execute(
                _NOTIFY,
                (CHANNEL, resync_event().to_transport_json()),
            )
        except Exception as error:  # Thread boundary: the resync stays pending.
            self._close(database_url)
            _log_failure("publish_failed", failure_cause(error))
            delay = min(
                self._retry_delays.get(database_url, _RETRY_SECONDS / 2) * 2,
                _MAX_RETRY_SECONDS,
            )
            self._retry_delays[database_url] = delay
            with self._state:
                self._resync_due[database_url] = time.monotonic() + delay
            return
        self._retry_delays.pop(database_url, None)
        with self._state:
            self._resync_due.pop(database_url, None)
            self._state.notify_all()

    def _connection(self, database_url: str) -> Any:
        connection = self._connections.get(database_url)
        if connection is None:
            connection = _connect(database_url)
            self._connections[database_url] = connection
        return connection

    def _close(self, database_url: str) -> None:
        connection = self._connections.pop(database_url, None)
        if connection is not None:
            try:
                connection.close()
            except psycopg.Error:
                pass


def publish_invalidations(
    events: Iterable[InvalidationEvent], *, database_url: str | None = None
) -> bool:
    """Publish one committed transaction's deduplicated invalidations.

    ``database_url`` is the database the transaction committed to; a session bound to
    another database than the configured one must not notify the configured one.
    False means the synchronous publish failed and was logged.
    """

    bounded = _bounded(events)
    if not bounded:
        return True
    target = database_url or get_settings().database_url
    with _active_lock:
        publisher = _active
    if publisher is not None and publisher.enqueue(bounded, target):
        return True
    try:
        with _connect(target) as connection:
            _notify(connection, bounded)
    except psycopg.Error as error:
        _log_failure("publish_failed", failure_cause(error))
        return False
    return True


def publish_invalidation(event: InvalidationEvent) -> bool:
    """Publish one event for callers outside the audit transaction listener."""

    return publish_invalidations((event,))
