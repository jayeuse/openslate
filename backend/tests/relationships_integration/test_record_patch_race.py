"""Concurrent record saves and link creates resolve to one clear outcome over HTTP.

One request is paused inside its real code path after it holds the module and record
locks. The competing request starts only then, and the holder is released only after
PostgreSQL shows the competitor blocked behind it (pg_locks + pg_blocking_pids).
"""

import os
import threading
import time
from collections.abc import Callable
from typing import Any
from uuid import UUID

import httpx
import pytest
from sqlalchemy import Engine, event, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from tests.record_versions import record_version
from tests.relationships_integration.relationship_http_support import RelationshipHTTPFixture

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]
pytest_plugins = ("tests.relationships_integration.relationship_http_support",)

# Upper bound for every wait; the competitor's own lock wait is 2 s (LOCK_WAIT).
_WAIT = 10.0


class _Pause:
    """Hold the first statement that starts with ``prefix`` until the test releases it."""

    def __init__(self, engine: Engine, prefix: str) -> None:
        self.paused = threading.Event()
        self.release = threading.Event()
        self.holder_pid = 0
        self._engine = engine
        wanted = prefix.upper()

        def before_cursor_execute(
            _connection: Any, cursor: Any, statement: str, *_args: Any
        ) -> None:
            if self.paused.is_set() or not statement.lstrip().upper().startswith(wanted):
                return
            self.holder_pid = int(cursor.connection.info.backend_pid)
            self.paused.set()
            self.release.wait(_WAIT)

        self._listener = before_cursor_execute
        event.listen(engine, "before_cursor_execute", before_cursor_execute)

    def remove(self) -> None:
        self.release.set()
        if event.contains(self._engine, "before_cursor_execute", self._listener):
            event.remove(self._engine, "before_cursor_execute", self._listener)


def _wait_until_blocked_by(observer: Engine, holder_pid: int) -> None:
    """Poll until some backend waits for a lock that ``holder_pid`` holds."""

    deadline = time.monotonic() + _WAIT
    while time.monotonic() < deadline:
        with observer.connect() as connection:
            if connection.scalar(
                text(
                    "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted "
                    "AND :holder = ANY (pg_blocking_pids(pid)))"
                ),
                {"holder": holder_pid},
            ):
                return
        threading.Event().wait(0.01)
    raise AssertionError("the competing request never waited for the holder's lock")


def _race(
    fixture: RelationshipHTTPFixture,
    prefix: str,
    first: Callable[[], httpx.Response],
    second: Callable[[], httpx.Response],
) -> tuple[httpx.Response, httpx.Response]:
    """Run ``first`` until it pauses at ``prefix``, block ``second`` behind it, then release."""

    outcomes: dict[str, object] = {}

    def run(name: str, call: Callable[[], httpx.Response]) -> None:
        try:
            outcomes[name] = call()
        except Exception as error:  # noqa: BLE001 - a server error is recorded for the assertion
            outcomes[name] = error

    threads = {
        name: threading.Thread(target=run, args=(name, call))
        for name, call in (("first", first), ("second", second))
    }
    pause = _Pause(fixture.runtime_engine, prefix)
    try:
        threads["first"].start()
        assert pause.paused.wait(_WAIT), "the first request never reached its pause point"
        threads["second"].start()
        _wait_until_blocked_by(fixture.owner_engine, pause.holder_pid)
        pause.release.set()
    finally:
        # Release first so a failed poll cannot hang the holder; remove the listener only
        # after both requests finished, because removal mutates the engine's listener list.
        pause.release.set()
        for thread in threads.values():
            if thread.ident is not None:
                thread.join(_WAIT)
        pause.remove()
    assert not any(thread.is_alive() for thread in threads.values()), "a request hung"
    first_response, second_response = outcomes.get("first"), outcomes.get("second")
    assert isinstance(first_response, httpx.Response), f"first failed: {first_response!r}"
    assert isinstance(second_response, httpx.Response), f"second failed: {second_response!r}"
    return first_response, second_response


def _count(fixture: RelationshipHTTPFixture, sql: str, **params: object) -> int:
    with fixture.owner_engine.connect() as connection:
        return int(connection.scalar(text(sql), params) or 0)


def test_two_saves_with_the_same_if_match_keep_only_the_winner(
    relationship_http_fixture: RelationshipHTTPFixture,
) -> None:
    # A save that read the record before a concurrent save committed must not
    # overwrite it: the record lock re-reads updated_at, so the loser gets 412.
    fixture = relationship_http_fixture
    graph = fixture.graph
    assert graph is not None
    record_id = graph.target_id
    label_id = uuid7()
    with fixture.owner_engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO public.fields "
                "(id, module_id, name, type, required, position, config, is_deleted) "
                "VALUES (:id, :module_id, :name, 'text', false, 0, '{}'::jsonb, false)"
            ),
            {"id": label_id, "module_id": graph.target_module_id, "name": f"Label {label_id}"},
        )
    try:
        with Session(fixture.runtime_engine) as database:
            version = record_version(database, record_id)
        winner, loser = fixture.client(), fixture.client()

        def save(client: Any, value: str) -> Callable[[], httpx.Response]:
            return lambda: client.patch(
                f"/api/records/{record_id}",
                json={"data": {str(label_id): value}},
                headers={"If-Match": version},
            )

        first, second = _race(
            fixture, "UPDATE RECORDS ", save(winner, "winner"), save(loser, "loser")
        )

        assert first.status_code == 200, first.text
        assert second.status_code == 412, second.text
        assert second.json() == {"detail": "Record changed"}
        with fixture.owner_engine.connect() as connection:
            data = connection.scalar(
                text("SELECT data FROM public.records WHERE id = :id"), {"id": record_id}
            )
        assert data[str(label_id)] == "winner"
        assert "loser" not in data.values()
        assert (
            _count(
                fixture,
                "SELECT count(*) FROM public.audit_logs "
                "WHERE entity_id = :id AND action = 'update'",
                id=record_id,
            )
            == 1
        )
        assert (
            _count(
                fixture,
                "SELECT count(*) FROM public.record_trigger_events WHERE record_id = :id",
                id=record_id,
            )
            == 1
        )
    finally:
        with fixture.owner_engine.begin() as connection:
            connection.execute(
                text("DELETE FROM public.record_trigger_events WHERE record_id = :id"),
                {"id": record_id},
            )
            connection.execute(text("DELETE FROM public.fields WHERE id = :id"), {"id": label_id})


@pytest.mark.parametrize(
    ("same_target", "second_status", "edges"),
    [(True, 409, 1), (False, 201, 2)],
    ids=["same-pair", "two-targets"],
)
def test_two_link_creates_on_one_source_resolve_to_one_outcome(
    relationship_http_fixture: RelationshipHTTPFixture,
    same_target: bool,
    second_status: int,
    edges: int,
) -> None:
    # Both creates lock the same module and source rows. The second waits, then sees
    # the committed edge: the same pair is a duplicate, another target is a new link.
    fixture = relationship_http_fixture
    graph = fixture.graph
    assert graph is not None
    field_id = uuid7()
    with fixture.owner_engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO public.fields "
                "(id, module_id, name, type, required, position, config, "
                "relationship_target_module_id, relationship_multiple_targets, "
                "relationship_multiple_sources, is_deleted) VALUES "
                "(:id, :module_id, :name, 'relationship', false, 3, '{}'::jsonb, "
                ":target_module_id, true, true, false)"
            ),
            {
                "id": field_id,
                "module_id": graph.source_module_id,
                "name": f"Many {field_id}",
                "target_module_id": graph.target_module_id,
            },
        )
    try:
        first_client, second_client = fixture.client(), fixture.client()
        second_target = graph.target_id if same_target else graph.replacement_id

        def link(client: Any, target_id: UUID) -> Callable[[], httpx.Response]:
            return lambda: client.post(
                "/api/relationships",
                json={
                    "field_id": str(field_id),
                    "source_record_id": str(graph.source_id),
                    "target_record_id": str(target_id),
                },
            )

        first, second = _race(
            fixture,
            "INSERT INTO RELATIONSHIP_EDGES",
            link(first_client, graph.target_id),
            link(second_client, second_target),
        )

        assert first.status_code == 201, first.text
        assert second.status_code == second_status, second.text
        if same_target:
            assert second.json() == {"detail": "Relationship already exists"}
        assert (
            _count(
                fixture,
                "SELECT count(*) FROM public.relationship_edges "
                "WHERE field_id = :id AND is_deleted = false",
                id=field_id,
            )
            == edges
        )
    finally:
        with fixture.owner_engine.begin() as connection:
            connection.execute(
                text("DELETE FROM public.relationship_edges WHERE field_id = :id"),
                {"id": field_id},
            )
            connection.execute(text("DELETE FROM public.fields WHERE id = :id"), {"id": field_id})
