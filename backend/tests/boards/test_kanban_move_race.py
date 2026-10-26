"""Concurrent Kanban moves over HTTP: ranks stay distinct and ordered, stale moves are 409.

Every Kanban write locks the Board row first. The first move is held at its card UPDATE
while it holds that lock; the second starts only then, and the first is released once
PostgreSQL shows the second blocked behind it (pg_locks + pg_blocking_pids).
"""

import os
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.systems.boards.kanban_models import BoardCard, BoardStage
from app.systems.boards.models import Board, BoardScope
from tests.race_support import WAIT, StatementPause, wait_until_blocked_by
from tests.relationships_integration.relationship_http_support import RelationshipHTTPFixture

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("TEST_DATABASE_URL") is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]
pytest_plugins = ("tests.relationships_integration.relationship_http_support",)


@dataclass(frozen=True)
class _World:
    fixture: RelationshipHTTPFixture
    board_id: UUID
    todo_id: UUID
    doing_id: UUID
    first_id: UUID
    second_id: UUID


@pytest.fixture
def world(relationship_http_fixture: RelationshipHTTPFixture) -> Iterator[_World]:
    """A committed project Board with two cards in To do and an empty Doing stage."""

    fixture = relationship_http_fixture
    with Session(fixture.owner_engine) as database:
        board = Board(org_id=fixture.org_id, scope=BoardScope.PROJECT.value,
                      name=f"Kanban race {fixture.actor_id.hex[:12]}")
        database.add(board)
        database.flush()
        todo = BoardStage(org_id=board.org_id, board_id=board.id, name="To do", position=0)
        doing = BoardStage(org_id=board.org_id, board_id=board.id, name="Doing", position=1)
        database.add_all((todo, doing))
        database.flush()
        cards = [
            BoardCard(org_id=board.org_id, board_id=board.id, stage_id=todo.id,
                      kind="objective", title=title, rank=rank)
            for title, rank in (("First", 1024), ("Second", 2048))
        ]
        database.add_all(cards)
        database.commit()
        ids = (board.id, todo.id, doing.id, cards[0].id, cards[1].id)
    try:
        yield _World(fixture, *ids)
    finally:
        with fixture.owner_engine.begin() as connection:
            for table in ("board_cards", "board_stages", "boards"):
                column = "id" if table == "boards" else "board_id"
                connection.execute(
                    text(f"DELETE FROM public.{table} WHERE {column} = :id"), {"id": ids[0]}
                )


def _race(
    world: _World,
    first: Callable[[Any], httpx.Response],
    second: Callable[[Any], httpx.Response],
) -> tuple[httpx.Response, httpx.Response]:
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
    pause = StatementPause(world.fixture.runtime_engine, "UPDATE BOARD_CARDS")
    try:
        threads["first"].start()
        assert pause.paused.wait(WAIT), "the first move never reached its card update"
        threads["second"].start()
        wait_until_blocked_by(world.fixture.owner_engine, pause.holder_pid)
        pause.release.set()
    finally:
        pause.release.set()
        for thread in threads.values():
            if thread.ident is not None:
                thread.join(WAIT)
        pause.remove()
    assert not any(thread.is_alive() for thread in threads.values()), "a request hung"
    first_response, second_response = outcomes.get("first"), outcomes.get("second")
    assert isinstance(first_response, httpx.Response), f"first failed: {first_response!r}"
    assert isinstance(second_response, httpx.Response), f"second failed: {second_response!r}"
    return first_response, second_response


def _move(world: _World, card_id: UUID) -> Callable[[Any], httpx.Response]:
    return lambda client: client.patch(
        f"/api/boards/{world.board_id}/cards/{card_id}",
        json={"revision": 1, "stage_id": str(world.doing_id), "position": 0},
    )


def _doing(world: _World) -> list[tuple[str, int]]:
    with world.fixture.owner_engine.connect() as connection:
        return [
            (row.title, row.rank)
            for row in connection.execute(
                text("SELECT title, rank FROM public.board_cards WHERE stage_id = :id "
                     "AND archived_at IS NULL ORDER BY rank"),
                {"id": world.doing_id},
            )
        ]


def test_two_cards_moved_to_the_same_place_at_once_get_distinct_ordered_ranks(
    world: _World,
) -> None:
    first, second = _race(world, _move(world, world.first_id), _move(world, world.second_id))

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    # The second move saw the first one's card and went in front of it.
    assert _doing(world) == [("Second", 512), ("First", 1024)]


def test_a_second_move_of_the_same_card_with_the_old_revision_is_refused(
    world: _World,
) -> None:
    first, second = _race(world, _move(world, world.first_id), lambda client: client.patch(
        f"/api/boards/{world.board_id}/cards/{world.first_id}",
        json={"revision": 1, "stage_id": str(world.todo_id), "position": 1},
    ))

    assert first.status_code == 200, first.text
    assert second.status_code == 409, second.text
    assert second.json()["detail"]["code"] == "stale_card_revision"
    assert _doing(world) == [("First", 1024)]
