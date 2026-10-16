"""Concurrent relationship writes wait briefly for each other instead of failing."""

import os
import threading
from uuid import UUID

import pytest
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.sandbox.relationships.service import create_relationship
from tests.conftest import guarded_create_engine as create_engine
from tests.organization_scope_support import in_context
from tests.race_support import wait_until_waiting
from tests.relationships_integration.relationships_integration_support import (
    _seed_committed_graph,
    _set_request,
)

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


def test_two_concurrent_link_writes_in_the_same_modules_both_succeed(
    integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    # Live runs measured 34 retried 503s per School Standard run: both writes lock
    # the same module rows, and NOWAIT failed the second at once.
    field, _, _, sources, targets, _ = _seed_committed_graph(owned_ids, record_count=2)
    assert TEST_DATABASE_URL is not None
    engine = create_engine(TEST_DATABASE_URL)
    first_holds_locks = threading.Event()
    second_waits = threading.Event()
    second_pids: list[int] = []
    outcomes: dict[str, object] = {}

    def write(name: str, source: UUID, target: UUID, *, hold: bool) -> None:
        with AuditSession(engine, expire_on_commit=False) as session:
            _set_request(session, uuid7())
            if hold:
                commit = session.commit

                def held_commit() -> None:
                    first_holds_locks.set()
                    # Hang guard only: the test releases this as soon as it sees the wait.
                    second_waits.wait(5)
                    commit()

                session.commit = held_commit  # type: ignore[method-assign]  # test seam
            else:
                pid = session.connection().exec_driver_sql("SELECT pg_backend_pid()").scalar_one()
                second_pids.append(pid)
            try:
                outcomes[name] = create_relationship(session, field.id, source, target)
            except Exception as error:  # noqa: BLE001 - recorded for the assertion
                outcomes[name] = error

    first = threading.Thread(
        target=in_context(write),
        args=("first", sources[0].id, targets[0].id),
        kwargs={"hold": True},
    )
    second = threading.Thread(
        target=in_context(write),
        args=("second", sources[1].id, targets[1].id),
        kwargs={"hold": False},
    )
    observed_wait = False
    try:
        first.start()
        assert first_holds_locks.wait(5)
        second.start()
        # Watch for the second write's lock wait, well inside its 2 s lock_timeout.
        observed_wait = wait_until_waiting(engine, second_pids, wait=1.5, while_running=second)
    finally:
        second_waits.set()
        first.join(5)
        second.join(5)
        engine.dispose()

    assert observed_wait, "the second write never waited for the first write's locks"
    for name in ("first", "second"):
        outcome = outcomes[name]
        assert not isinstance(outcome, Exception), f"{name} write failed: {outcome!r}"
        owned_ids.add(outcome.id)  # type: ignore[attr-defined]


def test_a_link_write_sets_the_lock_wait_once_per_transaction(
    integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    # Each lock helper used to repeat SET LOCAL, adding up to four round trips per request.
    from sqlalchemy import event

    field, _, _, sources, targets, _ = _seed_committed_graph(owned_ids)
    assert TEST_DATABASE_URL is not None
    engine = create_engine(TEST_DATABASE_URL)
    statements: list[str] = []

    @event.listens_for(engine, "before_cursor_execute")
    def record(_conn, _cursor, statement, *_args) -> None:  # noqa: ANN001
        statements.append(statement)

    try:
        with AuditSession(engine, expire_on_commit=False) as session:
            _set_request(session, uuid7())
            created = create_relationship(session, field.id, sources[0].id, targets[0].id)
            owned_ids.add(created.id)
    finally:
        engine.dispose()
    assert sum("lock_timeout" in statement for statement in statements) == 1
