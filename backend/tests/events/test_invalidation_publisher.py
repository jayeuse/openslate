"""The process invalidation publisher: commits enqueue, one thread notifies, losses resync."""

import threading
from types import SimpleNamespace

import psycopg
import pytest
from sqlalchemy import create_engine
from uuid6 import uuid7

from app.systems.manage.audit import listeners
from app.systems.platform.events import publisher
from app.systems.platform.events.models import InvalidationEvent

MODULE = uuid7()
ORGANIZATION = uuid7()
COMMITTED_URL = "postgresql+psycopg://owner:secret@db.test:5432/openslate"
RESYNC = '{"entity":"resync"}'


class FakeDatabase:
    """Record which thread connects where, and every NOTIFY each connection sends."""

    def __init__(self) -> None:
        self.connects: list[tuple[str, str]] = []
        self.notifies: list[tuple[str, str]] = []
        self.fail_next_notify: list[psycopg.Error] = []
        self.hold_first_connect: threading.Event | None = None
        self.first_connect_entered = threading.Event()

    def connect(self, url: str, **_options: object) -> "FakeConnection":
        self.connects.append((threading.current_thread().name, url))
        if self.hold_first_connect is not None and len(self.connects) == 1:
            self.first_connect_entered.set()
            # Hang guard only: the test releases the hold explicitly.
            assert self.hold_first_connect.wait(5), "the test never released the connect"
        return FakeConnection(self, url)


class FakeConnection:
    def __init__(self, database: FakeDatabase, url: str) -> None:
        self.database, self.url = database, url

    def __enter__(self) -> "FakeConnection":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def close(self) -> None:
        return None

    def execute(self, statement: str, parameters: tuple[str, str]) -> None:
        assert statement == "SELECT pg_notify(%s, %s)"
        if self.database.fail_next_notify:
            raise self.database.fail_next_notify.pop()
        assert parameters[0] == "openslate_invalidation"
        self.database.notifies.append((self.url, parameters[1]))


@pytest.fixture
def database(monkeypatch: pytest.MonkeyPatch) -> FakeDatabase:
    fake = FakeDatabase()
    monkeypatch.setattr(
        publisher,
        "get_settings",
        lambda: SimpleNamespace(
            database_url="postgresql+psycopg://user:secret@configured.test/openslate",
            database_connect_timeout_seconds=3,
            database_statement_timeout_ms=15_000,
        ),
    )
    monkeypatch.setattr(publisher.psycopg, "connect", fake.connect)
    return fake


@pytest.fixture
def failures(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, object]]:
    logged: list[dict[str, object]] = []
    monkeypatch.setattr(
        publisher, "log_event", lambda event, **fields: logged.append({"event": event, **fields})
    )
    return logged


@pytest.fixture
def running(database: FakeDatabase):
    """Start a process publisher; stop it before the connect patch is undone."""

    started: list[publisher.InvalidationPublisher] = []

    def start(**options: int) -> publisher.InvalidationPublisher:
        instance = publisher.InvalidationPublisher(**options)
        instance.start()
        started.append(instance)
        return instance

    yield start
    for instance in started:
        instance.stop()


def _record(entity_id: object) -> InvalidationEvent:
    return InvalidationEvent("records", entity_id=entity_id, module_id=MODULE, org_id=ORGANIZATION)


def _payload(entity_id: object) -> str:
    return (
        f'{{"entity":"records","entity_id":"{entity_id}",'
        f'"module_id":"{MODULE}","org_id":"{ORGANIZATION}"}}'
    )


def test_two_hundred_commits_enqueue_without_connecting_and_share_one_connection(
    database: FakeDatabase,
    running,
) -> None:
    instance = running()
    engine = create_engine(COMMITTED_URL)
    ids = [uuid7() for _ in range(200)]

    for entity_id in ids:
        listeners.broadcast_committed_changes(
            SimpleNamespace(
                info={listeners.REALTIME_INVALIDATION_KEY: [_record(entity_id)]},
                in_nested_transaction=lambda: False,
                get_bind=lambda: engine,
            )
        )

    committing = threading.current_thread().name
    assert [url for thread, url in database.connects if thread == committing] == []
    assert instance.drain(5)
    assert database.connects == [
        ("openslate-invalidations", "postgresql://owner:secret@db.test:5432/openslate")
    ]
    assert [payload for _url, payload in database.notifies] == [_payload(i) for i in ids]


def test_a_failed_publish_logs_its_cause_then_sends_one_resync_and_delivery_resumes(
    database: FakeDatabase,
    failures: list[dict[str, object]],
    running,
) -> None:
    instance = running()
    lost, later = uuid7(), uuid7()
    database.fail_next_notify.append(psycopg.errors.QueryCanceled("private detail"))

    assert publisher.publish_invalidations((_record(lost),), database_url=COMMITTED_URL)
    assert publisher.publish_invalidations((_record(later),), database_url=COMMITTED_URL)

    assert instance.drain(5)
    # The failed connection is replaced; the lost commit becomes one resync.
    assert [thread for thread, _url in database.connects] == ["openslate-invalidations"] * 2
    assert [payload for _url, payload in database.notifies] == [RESYNC, _payload(later)]
    assert failures == [
        {
            "event": "realtime_invalidation_failure",
            "level": 30,
            "reason_code": "publish_failed",
            "upstream": "postgresql",
            "cause": "database_statement_timeout",
        }
    ]


def test_a_full_queue_drops_into_one_coalesced_resync(
    database: FakeDatabase,
    failures: list[dict[str, object]],
    running,
) -> None:
    database.hold_first_connect = threading.Event()
    instance = running(queue_size=1)
    first, queued, dropped, also_dropped = (uuid7() for _ in range(4))

    publisher.publish_invalidations((_record(first),), database_url=COMMITTED_URL)
    # Hang guard: the publisher thread now holds the first item in its connect.
    assert database.first_connect_entered.wait(5)
    for entity_id in (queued, dropped, also_dropped):
        publisher.publish_invalidations((_record(entity_id),), database_url=COMMITTED_URL)
    database.hold_first_connect.set()

    assert instance.drain(5)
    assert [payload for _url, payload in database.notifies] == [
        _payload(first),
        RESYNC,
        _payload(queued),
    ]
    assert [entry["reason_code"] for entry in failures] == ["publish_queue_full"]


def test_each_commit_notifies_only_the_database_it_committed_to(
    database: FakeDatabase,
    running,
) -> None:
    instance = running()
    on_a, on_b = uuid7(), uuid7()

    publisher.publish_invalidations(
        (_record(on_a),), database_url="postgresql+psycopg://owner:secret@db-a.test/openslate"
    )
    publisher.publish_invalidations(
        (_record(on_b),), database_url="postgresql+psycopg://owner:secret@db-b.test/openslate"
    )

    assert instance.drain(5)
    assert database.notifies == [
        ("postgresql://owner:secret@db-a.test/openslate", _payload(on_a)),
        ("postgresql://owner:secret@db-b.test/openslate", _payload(on_b)),
    ]
    assert all("configured.test" not in url for _thread, url in database.connects)


def test_stop_sends_what_was_queued_and_later_commits_publish_directly(
    database: FakeDatabase,
    running,
) -> None:
    database.hold_first_connect = threading.Event()
    instance = running()
    queued, after_stop = uuid7(), uuid7()

    publisher.publish_invalidations((_record(queued),), database_url=COMMITTED_URL)
    assert database.first_connect_entered.wait(5)
    database.hold_first_connect.set()
    assert instance.stop()
    # A process without a running publisher (CLI, operations) still publishes.
    assert publisher.publish_invalidations((_record(after_stop),), database_url=COMMITTED_URL)

    assert [thread for thread, _url in database.connects] == [
        "openslate-invalidations",
        threading.current_thread().name,
    ]
    assert [payload for _url, payload in database.notifies] == [
        _payload(queued),
        _payload(after_stop),
    ]


def test_the_app_starts_the_publisher_and_stops_it_after_every_committing_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio

    from fastapi import FastAPI

    from app import main

    order: list[str] = []
    app = FastAPI()
    for name in (
        "comms_publisher",
        "trigger_worker",
        "report_scheduling_worker",
        "provider_signout_worker",
        "invalidation_publisher",
        "events_listener",
    ):
        setattr(
            app.state,
            name,
            SimpleNamespace(
                start=lambda name=name: order.append(f"{name}:start"),
                stop=lambda name=name: order.append(f"{name}:stop") or True,
            ),
        )
    monkeypatch.setattr(main, "configure_observability_logging", lambda: None)
    monkeypatch.setattr(main, "instance_target_for_process", lambda *_args: None)
    monkeypatch.setattr(main, "dispose_readiness_resources", lambda: None)
    monkeypatch.setattr(main, "dispose_database_resources", lambda: None)

    async def exercise() -> None:
        async with main.application_lifespan(app):
            order.append("serving")

    asyncio.run(exercise())

    assert order.index("invalidation_publisher:start") < order.index("serving")
    stopped = order[order.index("serving") + 1 :]
    assert stopped[-2:] == ["invalidation_publisher:stop", "events_listener:stop"]
