"""Bounded local fanout and one dedicated PostgreSQL notification listener."""

import asyncio
import logging
import random
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import psycopg
from sqlalchemy.engine import make_url

from app.core.config import get_settings
from app.core.observability import log_event
from app.systems.platform.events.models import (
    PRIVATE_NOTIFICATION_ENTITY,
    RESYNC_ENTITY,
    InvalidationEvent,
    parse_invalidation_payload,
)

CHANNEL = "openslate_invalidation"
_CONNECT_RETRY_SECONDS = 0.25
_MAX_CONNECT_RETRY_SECONDS = 5.0
_SHUTDOWN_JOIN_SECONDS = 2.0
_DEFAULT_MAX_SUBSCRIBERS = 128
_DEFAULT_MAX_SUBSCRIBERS_PER_USER = 4
_RESERVED_HTTP_CONCURRENCY = 8


class SubscriberLimitReached(RuntimeError):
    """The event hub cannot safely admit another stream."""


def subscriber_capacity(server_max_concurrency: int) -> int:
    """Leave Uvicorn slots available for ordinary requests and health checks."""

    return min(
        _DEFAULT_MAX_SUBSCRIBERS,
        max(1, server_max_concurrency - _RESERVED_HTTP_CONCURRENCY),
    )


@dataclass(frozen=True, slots=True)
class EventViewer:
    """A subscriber's identity and readable modules from one fresh database check.

    ``module_ids`` is None for an administrator, who reads every module.
    """

    user_id: object
    role: str | None
    module_ids: frozenset[UUID] | None


@dataclass(slots=True)
class EventSubscription:
    queue: asyncio.Queue[InvalidationEvent | None]
    viewer: EventViewer
    access_signature: tuple[str, ...]
    user_id: object
    closed: bool = False


class EventHub:
    """Own bounded SSE queues for one FastAPI process."""

    def __init__(
        self,
        *,
        subscriber_queue_size: int = 32,
        max_subscribers: int = _DEFAULT_MAX_SUBSCRIBERS,
        max_subscribers_per_user: int = _DEFAULT_MAX_SUBSCRIBERS_PER_USER,
    ) -> None:
        self._subscriber_queue_size = subscriber_queue_size
        self._max_subscribers = max_subscribers
        self._max_subscribers_per_user = max_subscribers_per_user
        self._by_id: dict[int, EventSubscription] = {}
        self._subscribers_by_user: dict[object, int] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    @property
    def subscriber_count(self) -> int:
        return len(self._by_id)

    def can_subscribe(self, viewer: EventViewer) -> bool:
        user_id = viewer.user_id
        return (
            len(self._by_id) < self._max_subscribers
            and self._subscribers_by_user.get(user_id, 0) < self._max_subscribers_per_user
        )

    async def subscribe(self, viewer: EventViewer) -> EventSubscription:
        user_id = viewer.user_id
        if not self.can_subscribe(viewer):
            raise SubscriberLimitReached("event subscriber capacity reached")
        subscription = EventSubscription(
            queue=asyncio.Queue(maxsize=self._subscriber_queue_size),
            viewer=viewer,
            access_signature=_access_signature(viewer),
            user_id=user_id,
        )
        self._loop = asyncio.get_running_loop()
        identifier = id(subscription)
        self._by_id[identifier] = subscription
        self._subscribers_by_user[user_id] = self._subscribers_by_user.get(user_id, 0) + 1
        return subscription

    async def unsubscribe(self, subscription: EventSubscription) -> None:
        subscription.closed = True
        self._remove(subscription)

    def refresh_subscription(self, subscription: EventSubscription, viewer: EventViewer) -> bool:
        """Replace the detached access snapshot after a fresh identity check."""

        signature = _access_signature(viewer)
        changed = subscription.access_signature != signature
        subscription.viewer = viewer
        subscription.access_signature = signature
        return changed

    def can_receive(self, subscription: EventSubscription, event: InvalidationEvent) -> bool:
        return not subscription.closed and _can_receive(subscription, event)

    async def publish(self, event: InvalidationEvent) -> None:
        self._dispatch(event)

    async def publish_notification(self, payload: object) -> None:
        try:
            event = parse_invalidation_payload(payload)
        except ValueError:
            log_event(
                "realtime_invalidation_failure",
                level=logging.WARNING,
                reason_code="invalid_notification_payload",
                upstream="postgresql",
            )
            return
        if event.entity == RESYNC_ENTITY:
            self._dispatch_resync()
            return
        self._dispatch(event)

    async def publish_resync(self) -> None:
        self._dispatch_resync()

    def publish_from_listener(self, payload: object) -> None:
        """Accept a validated-at-boundary notification from the listener thread."""

        loop = self._loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(self._schedule_notification, payload)

    def publish_resync_from_listener(self) -> None:
        loop = self._loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(self._dispatch_resync)

    def _schedule_notification(self, payload: object) -> None:
        asyncio.create_task(self.publish_notification(payload))

    def _dispatch(self, event: InvalidationEvent) -> None:
        for subscription in tuple(self._by_id.values()):
            if subscription.closed or not _can_receive(subscription, event):
                continue
            self._queue(subscription, event)

    def _dispatch_resync(self) -> None:
        for subscription in tuple(self._by_id.values()):
            if not subscription.closed:
                self._queue(subscription, None)

    def _queue(self, subscription: EventSubscription, event: InvalidationEvent | None) -> None:
        try:
            subscription.queue.put_nowait(event)
        except asyncio.QueueFull:
            subscription.closed = True

    def _remove(self, subscription: EventSubscription) -> None:
        if self._by_id.pop(id(subscription), None) is None:
            return
        count = self._subscribers_by_user.get(subscription.user_id, 0)
        if count <= 1:
            self._subscribers_by_user.pop(subscription.user_id, None)
        else:
            self._subscribers_by_user[subscription.user_id] = count - 1


def _can_receive(subscription: EventSubscription, event: InvalidationEvent) -> bool:
    viewer = subscription.viewer
    if viewer.role is None:
        return False
    if event.entity == PRIVATE_NOTIFICATION_ENTITY:
        return event.recipient_id is not None and subscription.user_id == event.recipient_id
    if event.all_authenticated:
        return True
    if viewer.module_ids is None:
        return viewer.role == "admin"
    if event.administrators_only or event.module_id is None:
        return False
    return event.module_id in viewer.module_ids


def _access_signature(viewer: EventViewer) -> tuple[str, ...]:
    if viewer.role is None:
        return ()
    if viewer.module_ids is None:
        return (viewer.role,)
    return (viewer.role, *sorted(str(module_id) for module_id in viewer.module_ids))


class PostgresInvalidationListener:
    """Own one direct session-affine LISTEN connection per FastAPI process."""

    def __init__(
        self,
        hub: EventHub,
        database_url: str | None = None,
        *,
        connect: Callable[..., Any] = psycopg.connect,
        connect_timeout_seconds: int | None = None,
        statement_timeout_ms: int | None = None,
    ) -> None:
        self._hub = hub
        if database_url is None:
            database_url = _psycopg_url(get_settings().database_url)
        if connect_timeout_seconds is None:
            connect_timeout_seconds = get_settings().database_connect_timeout_seconds
        if statement_timeout_ms is None:
            statement_timeout_ms = get_settings().database_statement_timeout_ms
        self._database_url = database_url
        self._connect = connect
        self._connect_options = {
            "autocommit": True,
            "connect_timeout": connect_timeout_seconds,
            "options": f"-c statement_timeout={statement_timeout_ms}",
        }
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._connection_lock = threading.Lock()
        self._connection: Any | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="openslate-events", daemon=True)
        self._thread.start()

    def stop(self) -> bool:
        self._stop.set()
        with self._connection_lock:
            connection = self._connection
        if connection is not None:
            try:
                connection.close()
            except psycopg.Error:
                pass
        thread = self._thread
        if thread is None:
            return True
        thread.join(timeout=_SHUTDOWN_JOIN_SECONDS)
        if thread.is_alive():
            log_event(
                "realtime_invalidation_failure",
                level=logging.WARNING,
                reason_code="listener_shutdown_timeout",
                upstream="postgresql",
            )
            return False
        self._thread = None
        return True

    def _run(self) -> None:
        retry_seconds = _CONNECT_RETRY_SECONDS
        while not self._stop.is_set():
            try:
                with self._connect(self._database_url, **self._connect_options) as connection:
                    with self._connection_lock:
                        self._connection = connection
                    connection.execute(f"LISTEN {CHANNEL}")
                    self._hub.publish_resync_from_listener()
                    retry_seconds = _CONNECT_RETRY_SECONDS
                    while not self._stop.is_set():
                        for notification in connection.notifies(timeout=0.5, stop_after=1):
                            self._hub.publish_from_listener(notification.payload)
            except psycopg.Error:
                log_event(
                    "realtime_invalidation_failure",
                    level=logging.WARNING,
                    reason_code="listener_connection_failed",
                    upstream="postgresql",
                )
                delay = retry_seconds * random.uniform(0.8, 1.2)
                self._stop.wait(delay)
                retry_seconds = min(retry_seconds * 2, _MAX_CONNECT_RETRY_SECONDS)
            finally:
                with self._connection_lock:
                    self._connection = None


def _psycopg_url(database_url: str) -> str:
    return make_url(database_url).set(drivername="postgresql").render_as_string(hide_password=False)
