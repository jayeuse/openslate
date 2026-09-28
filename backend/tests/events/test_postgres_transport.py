"""Direct PostgreSQL transport tests without a shared database."""

import asyncio
import threading
from types import SimpleNamespace

import psycopg
from uuid6 import uuid7

from app.systems.platform.events.hub import EventViewer, PostgresInvalidationListener
from app.systems.platform.events.models import InvalidationEvent, event_for_entity
from app.systems.platform.events.publisher import publish_invalidation, publish_invalidations

READABLE_MODULE = uuid7()


def test_publisher_sends_only_the_opaque_payload_with_pg_notify(monkeypatch) -> None:
    commands: list[tuple[str, tuple[str, str]]] = []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def execute(self, statement: str, parameters: tuple[str, str]) -> None:
            commands.append((statement, parameters))

    monkeypatch.setattr(
        "app.systems.platform.events.publisher.get_settings",
        lambda: SimpleNamespace(
            database_url="postgresql+psycopg://user:secret@db/openslate",
            database_connect_timeout_seconds=3,
            database_statement_timeout_ms=15_000,
        ),
    )
    connect_calls: list[dict[str, object]] = []

    def connect(*_args: object, **kwargs: object) -> Connection:
        connect_calls.append(kwargs)
        return Connection()

    monkeypatch.setattr(
        "app.systems.platform.events.publisher.psycopg.connect",
        connect,
    )

    recipient_id = uuid7()
    private_event = event_for_entity("in_app_notifications", uuid7(), recipient_id=recipient_id)
    assert private_event is not None
    assert publish_invalidation(InvalidationEvent("records", module_id=READABLE_MODULE))
    assert publish_invalidation(private_event)
    assert commands == [
        (
            "SELECT pg_notify(%s, %s)",
            (
                "openslate_invalidation",
                f'{{"entity":"records","module_id":"{READABLE_MODULE}"}}',
            ),
        ),
        (
            "SELECT pg_notify(%s, %s)",
            (
                "openslate_invalidation",
                f'{{"entity":"in_app_notifications","recipient_id":"{recipient_id}"}}',
            ),
        ),
    ]
    assert connect_calls == [
        {"autocommit": True, "connect_timeout": 3, "options": "-c statement_timeout=15000"},
        {"autocommit": True, "connect_timeout": 3, "options": "-c statement_timeout=15000"},
    ]


def test_publisher_failure_is_best_effort(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.systems.platform.events.publisher.get_settings",
        lambda: SimpleNamespace(
            database_url="postgresql+psycopg://user:secret@db/openslate",
            database_connect_timeout_seconds=3,
            database_statement_timeout_ms=15_000,
        ),
    )

    def fail(*_args: object, **_kwargs: object) -> object:
        raise psycopg.OperationalError("unavailable")

    monkeypatch.setattr("app.systems.platform.events.publisher.psycopg.connect", fail)

    assert not publish_invalidation(InvalidationEvent("records"))


def test_large_commit_collapses_to_one_resync_notification(monkeypatch) -> None:
    commands: list[tuple[str, tuple[str, str]]] = []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def execute(self, statement: str, parameters: tuple[str, str]) -> None:
            commands.append((statement, parameters))

    monkeypatch.setattr(
        "app.systems.platform.events.publisher.get_settings",
        lambda: SimpleNamespace(
            database_url="postgresql+psycopg://user:secret@db/openslate",
            database_connect_timeout_seconds=3,
            database_statement_timeout_ms=15_000,
        ),
    )
    monkeypatch.setattr("app.systems.platform.events.publisher.MAX_INVALIDATIONS_PER_COMMIT", 1)
    monkeypatch.setattr(
        "app.systems.platform.events.publisher.psycopg.connect",
        lambda *_args, **_kwargs: Connection(),
    )

    assert publish_invalidations(
        (
            InvalidationEvent("records", module_id=READABLE_MODULE),
            InvalidationEvent("modules", module_id=READABLE_MODULE),
        )
    )
    assert commands == [
        ("SELECT pg_notify(%s, %s)", ("openslate_invalidation", '{"entity":"resync"}'))
    ]


def test_private_notification_overflow_never_emits_a_global_resync(monkeypatch) -> None:
    commands: list[tuple[str, tuple[str, str]]] = []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def execute(self, statement: str, parameters: tuple[str, str]) -> None:
            commands.append((statement, parameters))

    monkeypatch.setattr(
        "app.systems.platform.events.publisher.get_settings",
        lambda: SimpleNamespace(
            database_url="postgresql+psycopg://user:secret@db/openslate",
            database_connect_timeout_seconds=3,
            database_statement_timeout_ms=15_000,
        ),
    )
    monkeypatch.setattr("app.systems.platform.events.publisher.MAX_INVALIDATIONS_PER_COMMIT", 2)
    monkeypatch.setattr(
        "app.systems.platform.events.publisher.psycopg.connect",
        lambda *_args, **_kwargs: Connection(),
    )
    private_events = tuple(
        event_for_entity("in_app_notifications", uuid7(), recipient_id=uuid7()) for _ in range(3)
    )
    assert all(event is not None for event in private_events)
    assert publish_invalidations(private_events)
    assert commands == []

    assert publish_invalidations(
        (*private_events, InvalidationEvent("records", module_id=READABLE_MODULE))
    )
    assert commands == [
        (
            "SELECT pg_notify(%s, %s)",
            (
                "openslate_invalidation",
                f'{{"entity":"records","module_id":"{READABLE_MODULE}"}}',
            ),
        )
    ]


def test_listener_reconnects_and_fans_out_notification() -> None:
    async def exercise() -> None:
        from app.systems.platform.events.hub import EventHub

        hub = EventHub()
        user = EventViewer(user_id=uuid7(), role="member", module_ids=frozenset({READABLE_MODULE}))
        subscription = await hub.subscribe(user)
        stop_wait = threading.Event()
        attempts = 0

        class Connection:
            delivered = False

            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def execute(self, _statement: str) -> None:
                return None

            def close(self) -> None:
                stop_wait.set()

            def notifies(self, **_kwargs: object):
                if not self.delivered:
                    self.delivered = True
                    yield SimpleNamespace(
                        payload=InvalidationEvent("records", module_id=READABLE_MODULE).to_json()
                    )
                else:
                    stop_wait.wait(0.5)

        def connect(*_args: object, **_kwargs: object) -> Connection:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise psycopg.OperationalError("first attempt fails")
            return Connection()

        listener = PostgresInvalidationListener(
            hub,
            "postgresql://user:secret@db/openslate",
            connect=connect,
            connect_timeout_seconds=3,
            statement_timeout_ms=15_000,
        )
        listener.start()
        try:
            assert await asyncio.wait_for(subscription.queue.get(), timeout=2) is None
            assert await asyncio.wait_for(subscription.queue.get(), timeout=2) == InvalidationEvent(
                "records", module_id=READABLE_MODULE
            )
            assert attempts >= 2
        finally:
            stop_wait.set()
            listener.stop()
            await hub.unsubscribe(subscription)

    asyncio.run(exercise())


def test_listener_reconnect_resyncs_subscribers_and_keeps_a_live_thread_reference() -> None:
    async def exercise() -> None:
        from app.systems.platform.events.hub import EventHub

        hub = EventHub()
        subscription = await hub.subscribe(
            EventViewer(user_id=uuid7(), role="member", module_ids=frozenset())
        )
        attempts = 0

        class Connection:
            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def close(self) -> None:
                return None

            def execute(self, _statement: str) -> None:
                return None

            def notifies(self, **_kwargs: object):
                raise psycopg.OperationalError("connection dropped")
                yield  # pragma: no cover - preserve generator shape for psycopg.

        def connect(*_args: object, **_kwargs: object) -> Connection:
            nonlocal attempts
            attempts += 1
            return Connection()

        listener = PostgresInvalidationListener(
            hub,
            "postgresql://user:secret@db/openslate",
            connect=connect,
            connect_timeout_seconds=3,
            statement_timeout_ms=15_000,
        )
        listener.start()
        try:
            assert await asyncio.wait_for(subscription.queue.get(), timeout=2) is None
            assert await asyncio.wait_for(subscription.queue.get(), timeout=2) is None
            assert attempts >= 2
        finally:
            listener.stop()
            await hub.unsubscribe(subscription)

    asyncio.run(exercise())


def test_stop_retains_a_thread_reference_when_bounded_shutdown_times_out(monkeypatch) -> None:
    from app.systems.platform.events.hub import EventHub

    release = threading.Event()
    listener = PostgresInvalidationListener(
        EventHub(),
        "postgresql://user:secret@db/openslate",
        connect_timeout_seconds=3,
        statement_timeout_ms=15_000,
    )
    thread = threading.Thread(target=release.wait)
    listener._thread = thread
    thread.start()
    monkeypatch.setattr("app.systems.platform.events.hub._SHUTDOWN_JOIN_SECONDS", 0)

    assert not listener.stop()
    assert listener._thread is thread

    release.set()
    thread.join(timeout=1)
    assert listener.stop()
