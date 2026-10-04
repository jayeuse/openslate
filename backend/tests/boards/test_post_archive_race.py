"""A post edit racing a Board or post archive gives one clear outcome over HTTP.

Every post and Board lifecycle write locks the Board row first. One request is paused
inside its real flush while it holds that lock; the competitor starts only then, and
the holder is released once PostgreSQL shows the competitor blocked behind it
(pg_locks + pg_blocking_pids). The competitor must then see the new Board revision.
"""

import os
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx
import pytest
from sqlalchemy import Engine, event, text
from sqlalchemy.orm import Session

from app.systems.boards.models import Board, BoardScope
from app.systems.boards.post_models import BoardPost
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

# Upper bound for every wait; the Board lock itself has no lock timeout.
_WAIT = 10.0
_TITLE = "Opening notice"
_BODY = "The office is open."


@dataclass(frozen=True)
class _World:
    fixture: RelationshipHTTPFixture
    board_id: UUID
    post_id: UUID


@pytest.fixture
def world(relationship_http_fixture: RelationshipHTTPFixture) -> Iterator[_World]:
    """A committed project Board with one draft post by the fixture's administrator."""

    fixture = relationship_http_fixture
    with Session(fixture.owner_engine) as database:
        board = Board(scope=BoardScope.PROJECT.value, name=f"Race {fixture.actor_id.hex[:12]}")
        database.add(board)
        database.flush()
        item = BoardPost(board_id=board.id, author_id=fixture.actor_id, title=_TITLE, body=_BODY)
        database.add(item)
        database.commit()
        board_id, post_id = board.id, item.id
    try:
        yield _World(fixture, board_id, post_id)
    finally:
        # The fixture removes the author and its audit rows after this.
        with fixture.owner_engine.begin() as connection:
            connection.execute(
                text("DELETE FROM public.board_posts WHERE board_id = :id"), {"id": board_id}
            )
            connection.execute(text("DELETE FROM public.boards WHERE id = :id"), {"id": board_id})


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
    world: _World,
    prefix: str,
    first: Callable[[Any], httpx.Response],
    second: Callable[[Any], httpx.Response],
) -> tuple[httpx.Response, httpx.Response]:
    """Run ``first`` until it pauses at ``prefix``, block ``second`` behind it, then release."""

    clients = {"first": world.fixture.client(), "second": world.fixture.client()}
    outcomes: dict[str, object] = {}

    def run(name: str, call: Callable[[Any], httpx.Response]) -> None:
        try:
            outcomes[name] = call(clients[name])
        except Exception as error:  # noqa: BLE001 - a server error is recorded for the assertion
            outcomes[name] = error

    threads = {
        name: threading.Thread(target=run, args=(name, call))
        for name, call in (("first", first), ("second", second))
    }
    pause = _Pause(world.fixture.runtime_engine, prefix)
    try:
        threads["first"].start()
        assert pause.paused.wait(_WAIT), "the first request never reached its pause point"
        threads["second"].start()
        _wait_until_blocked_by(world.fixture.owner_engine, pause.holder_pid)
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


def _edit(world: _World) -> Callable[[Any], httpx.Response]:
    return lambda client: client.patch(
        f"/api/boards/{world.board_id}/posts/{world.post_id}",
        json={"board_revision": 1, "post_revision": 1, "title": "Edited notice"},
    )


def _archive_board(world: _World) -> Callable[[Any], httpx.Response]:
    return lambda client: client.post(f"/api/boards/{world.board_id}/archive", json={"revision": 1})


def _archive_post(world: _World) -> Callable[[Any], httpx.Response]:
    return lambda client: client.post(
        f"/api/boards/{world.board_id}/posts/{world.post_id}/archive",
        json={"board_revision": 1, "post_revision": 1},
    )


def _rows(world: _World) -> tuple[dict[str, Any], dict[str, Any]]:
    with world.fixture.owner_engine.connect() as connection:
        board = connection.execute(
            text("SELECT status, revision FROM public.boards WHERE id = :id"),
            {"id": world.board_id},
        ).one()
        item = connection.execute(
            text("SELECT title, body, status, revision FROM public.board_posts WHERE id = :id"),
            {"id": world.post_id},
        ).one()
    return dict(board._mapping), dict(item._mapping)


def _stale(code: str) -> dict[str, object]:
    message = "Board changed; reload before saving"
    return {"detail": {"code": code, "message": message, "current_revision": 2}}


def test_a_board_archive_behind_a_post_edit_is_refused_as_stale(world: _World) -> None:
    # The edit commits Board revision 2, so the archive that read revision 1 must not
    # archive a Board whose content it has not seen.
    edited, archived = _race(world, "UPDATE BOARD", _edit(world), _archive_board(world))

    assert edited.status_code == 200, edited.text
    assert edited.json() == {"id": str(world.post_id), "post_revision": 2, "board_revision": 2}
    assert archived.status_code == 409, archived.text
    assert archived.json() == _stale("stale_revision")
    board, item = _rows(world)
    assert board == {"status": "active", "revision": 2}
    assert item == {"title": "Edited notice", "body": _BODY, "status": "draft", "revision": 2}


def test_a_post_edit_behind_a_board_archive_is_refused_and_changes_nothing(
    world: _World,
) -> None:
    archived, edited = _race(world, "UPDATE BOARDS ", _archive_board(world), _edit(world))

    assert archived.status_code == 200, archived.text
    assert archived.json()["status"] == "archived"
    assert archived.json()["revision"] == 2
    assert edited.status_code == 409, edited.text
    assert edited.json() == _stale("stale_board_revision")
    board, item = _rows(world)
    assert board == {"status": "archived", "revision": 2}
    assert item == {"title": _TITLE, "body": _BODY, "status": "draft", "revision": 1}


def test_a_post_archive_behind_a_post_edit_is_refused_as_stale(world: _World) -> None:
    edited, archived = _race(world, "UPDATE BOARD", _edit(world), _archive_post(world))

    assert edited.status_code == 200, edited.text
    assert archived.status_code == 409, archived.text
    assert archived.json() == _stale("stale_board_revision")
    board, item = _rows(world)
    assert board == {"status": "active", "revision": 2}
    assert item == {"title": "Edited notice", "body": _BODY, "status": "draft", "revision": 2}
