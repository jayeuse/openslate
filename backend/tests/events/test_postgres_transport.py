"""Direct PostgreSQL transport tests without a shared database."""

import asyncio
import threading
from types import SimpleNamespace

import psycopg

from app.systems.access.users.permissions import Capability
from app.systems.platform.events.hub import PostgresInvalidationListener
from app.systems.platform.events.models import InvalidationEvent
from app.systems.platform.events.publisher import publish_invalidation, publish_invalidations


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

    assert publish_invalidation(InvalidationEvent("records", capability=Capability.RECORDS_READ))
    assert commands == [
        (
            "SELECT pg_notify(%s, %s)",
            ("openslate_invalidation", '{"capability":"records.read","entity":"records"}'),
        )
    ]
    assert connect_calls == [
        {"autocommit": True, "connect_timeout": 3, "options": "-c statement_timeout=15000"}
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
            InvalidationEvent("records", capability=Capability.RECORDS_READ),
            InvalidationEvent("modules", capability=Capability.MODULES_READ),
        )
    )
    assert commands == [
        ("SELECT pg_notify(%s, %s)", ("openslate_invalidation", '{"entity":"resync"}'))
    ]


def test_listener_reconnects_and_fans_out_notification() -> None:
    async def exercise() -> None:
        from app.systems.platform.events.hub import EventHub

        hub = EventHub()
        user = SimpleNamespace(
            role=SimpleNamespace(role="member", permissions={"records.read": True})
        )
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
                        payload=InvalidationEvent(
                            "records", capability=Capability.RECORDS_READ
                        ).to_json()
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
                "records", capability=Capability.RECORDS_READ
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
            SimpleNamespace(role=SimpleNamespace(role="member", permissions={}))
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
