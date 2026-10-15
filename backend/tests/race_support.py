"""Hold one real request at a statement and prove a second request waits on its lock.

Race tests run two real HTTP requests on their own connections. ``StatementPause`` holds
the first statement that starts with a prefix until the test releases it; the test then
starts the competing request and ``wait_until_blocked_by`` waits for PostgreSQL to show
it waiting on a lock that the held connection owns; ``wait_until_waiting`` watches one
known waiter instead. A hold paused in Python code (a wrapped service function) names its
holder with ``backend_pid``. ``WAIT`` is a hang guard, far above loaded-machine latency;
no test asserts on elapsed time.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Sequence
from typing import Any

from sqlalchemy import event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

WAIT = 10.0


class StatementPause:
    """Hold the first statement that starts with ``prefix`` until ``release`` is set."""

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
            assert self.release.wait(WAIT), "the held real request was not released"

        self._listener = before_cursor_execute
        event.listen(engine, "before_cursor_execute", before_cursor_execute)

    def remove(self) -> None:
        self.release.set()
        if event.contains(self._engine, "before_cursor_execute", self._listener):
            event.remove(self._engine, "before_cursor_execute", self._listener)


def start(call: Callable[[], Any]) -> tuple[threading.Thread, list[Any]]:
    """Run ``call`` in a thread; its result or exception lands in the returned list."""

    results: list[Any] = []

    def run() -> None:
        try:
            results.append(call())
        except Exception as error:
            results.append(error)

    thread = threading.Thread(target=run)
    thread.start()
    return thread, results


def join(thread: threading.Thread, results: list[Any]) -> Any:
    thread.join(WAIT)
    assert not thread.is_alive(), "the real HTTP request hung"
    assert results and not isinstance(results[0], Exception), repr(results)
    return results[0]


def backend_pid(db: Session) -> int:
    """Return the backend of ``db``'s open transaction, for a hold paused in Python code."""

    return int(db.connection().connection.driver_connection.info.backend_pid)


def wait_until_blocked_by(observer: Engine, holder_pid: int) -> int:
    """Return the backend that waits for a lock ``holder_pid`` holds; fail after ``WAIT``."""

    deadline = time.monotonic() + WAIT
    while time.monotonic() < deadline:
        with observer.connect() as connection:
            waiting = connection.scalar(
                text(
                    "SELECT pid FROM pg_locks WHERE NOT granted "
                    "AND :holder = ANY(pg_blocking_pids(pid)) LIMIT 1"
                ),
                {"holder": holder_pid},
            )
        if waiting is not None:
            return int(waiting)
        threading.Event().wait(0.01)
    raise AssertionError("the competing real request never blocked on the holder")


def wait_until_waiting(
    observer: Engine,
    waiter_pids: Sequence[int],
    *,
    wait: float = WAIT,
    while_running: threading.Thread | None = None,
) -> bool:
    """Return whether the backend ``waiter_pids[0]`` waits for a lock within ``wait``.

    The waiting thread appends its backend pid to ``waiter_pids`` once it has a connection.
    The poll also stops when ``while_running`` finishes, for a waiter whose own lock
    timeout may end its wait first. The caller asserts the result with its own message.
    """

    deadline = time.monotonic() + wait
    while time.monotonic() < deadline and (while_running is None or while_running.is_alive()):
        if waiter_pids:
            with observer.connect() as connection:
                if connection.scalar(
                    text("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = :pid AND NOT granted)"),
                    {"pid": waiter_pids[0]},
                ):
                    return True
        threading.Event().wait(0.01)
    return False
