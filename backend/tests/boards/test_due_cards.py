"""My calendar's "My cards · Due": the viewer's due cards across every Board they read."""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime

import pytest
from sqlalchemy import event as sqlalchemy_event
from sqlalchemy.orm import Session

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.due_card_router import router as due_router
from app.systems.boards.models import BoardStatus
from tests.boards.kanban_support import add_objective, add_record_card, add_stage, record_source
from tests.boards.support import client, grant, member, project_board

ROOT = "/api/boards/cards/due"
NOVEMBER = {"from": "2026-11-01", "to": "2026-11-30"}


def _due(db: Session, actor: User, **params: str | int):
    return client(db, actor, due_router).get(ROOT, params={**NOVEMBER, **params})


@contextmanager
def _statements(db: Session) -> Iterator[list[str]]:
    executed: list[str] = []
    engine = db.get_bind().engine

    def record(_connection: object, _cursor: object, statement: str, *_args: object) -> None:
        if "set_config('openslate.org_id'" not in statement:
            executed.append(" ".join(statement.split())[:160])

    sqlalchemy_event.listen(engine, "before_cursor_execute", record)
    try:
        yield executed
    finally:
        sqlalchemy_event.remove(engine, "before_cursor_execute", record)


@pytest.mark.parametrize(
    "window",
    [
        {"from": "2026-11-01", "to": "2026-12-13"},  # 43 days
        {"from": "2026-11-02", "to": "2026-11-01"},  # reversed
        {"from": "2026-11-01"},  # no end
        {**NOVEMBER, "assignee": "00000000-0000-7000-8000-000000000001"},  # not me
    ],
)
@pytest.mark.integration
def test_the_window_is_inclusive_and_at_most_42_days(
    integration_owner_db: Session, window: dict[str, str]
) -> None:
    db = integration_owner_db
    actor = member(db)
    db.commit()
    response = client(db, actor, due_router).get(ROOT, params=window)
    assert response.status_code == 422


@pytest.mark.integration
def test_lists_only_my_active_due_cards_on_boards_i_read(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    me, other = member(db), member(db)
    first, second = sorted((project_board(db), project_board(db)), key=lambda b: str(b.id))
    hidden, archived_board = project_board(db), project_board(db)
    for board in (first, second, archived_board):
        grant(db, board, [me, other], AccessLevel.READ)
    grant(db, hidden, [other], AccessLevel.READ)
    stages = {board.id: add_stage(db, board) for board in (first, second, hidden, archived_board)}
    old = add_stage(db, first, "Old", 1, archived_at=datetime.now(UTC))
    source = record_source(db)  # ``me`` cannot read its module.

    def card(board, title, rank, due, **values):
        return add_objective(db, board, stages[board.id], title, rank,
                             assignee_id=values.pop("assignee_id", me.id), due_on=due, **values)

    card(second, "Same day, second board", 1024, date(2026, 11, 3))
    card(first, "Same day, later rank", 4096, date(2026, 11, 3))
    card(first, "Same day, first rank", 2048, date(2026, 11, 3))
    card(first, "Window start", 3072, date(2026, 11, 1))
    card(second, "Window end", 2048, date(2026, 11, 30))
    locked = add_record_card(db, first, stages[first.id], source.record, 8192)
    locked.assignee_id, locked.due_on = me.id, date(2026, 11, 20)
    card(first, "Before the window", 5120, date(2026, 10, 31))
    card(first, "After the window", 6144, date(2026, 12, 1))
    card(first, "Someone else's", 7168, date(2026, 11, 4), assignee_id=other.id)
    card(first, "No due date", 9216, None)
    card(first, "Archived card", 10240, date(2026, 11, 5), archived_at=datetime.now(UTC))
    add_objective(db, first, old, "On an archived stage", 1024, assignee_id=me.id,
                  due_on=date(2026, 11, 6))
    card(hidden, "Board I cannot read", 1024, date(2026, 11, 7))
    card(archived_board, "Archived Board", 1024, date(2026, 11, 8))
    archived_board.status = BoardStatus.ARCHIVED.value
    db.commit()

    response = _due(db, me, assignee="me")

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    items = response.json()["items"]
    assert [(item["title"], item["due_on"]) for item in items] == [
        ("Window start", "2026-11-01"),
        ("Same day, first rank", "2026-11-03"),
        ("Same day, later rank", "2026-11-03"),
        ("Same day, second board", "2026-11-03"),
        (None, "2026-11-20"),
        ("Window end", "2026-11-30"),
    ]
    assert items[0]["board"] == {
        "id": str(first.id), "name": first.name, "scope": "project", "department_id": None,
    }
    assert items[4]["kind"] == "record" and items[4]["record"] == {"locked": True}
    assert items[0]["stage_id"] == str(stages[first.id].id)

    page = _due(db, me, limit=2, offset=2)
    assert page.json()["pagination"] == {
        "limit": 2, "offset": 2, "count": 2, "total": 6, "has_more": True,
    }
    assert [item["title"] for item in page.json()["items"]] == [
        "Same day, later rank", "Same day, second board",
    ]

    granted = record_source(db, me)
    readable = add_record_card(db, second, stages[second.id], granted.record, 9216)
    readable.assignee_id, readable.due_on = me.id, date(2026, 11, 21)
    db.commit()
    summary = next(item for item in _due(db, me).json()["items"] if item["id"] == str(readable.id))
    assert summary["record"]["title"] == "Harbor crane quote"


@pytest.mark.integration
def test_the_statement_count_does_not_grow_with_the_number_of_boards(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    me = member(db)
    boards = [project_board(db) for _ in range(12)]
    for index, board in enumerate(boards):
        grant(db, board, [me], AccessLevel.READ)
        stage = add_stage(db, board)
        for day in (3, 17):
            add_objective(db, board, stage, f"Card {index}-{day}", day * 1024,
                          assignee_id=me.id, due_on=date(2026, 11, day))
    db.commit()

    def count(limit: int) -> int:
        with _statements(db) as executed:
            response = _due(db, me, limit=limit)
        assert response.status_code == 200, response.text
        return len(executed)

    count(2)  # Warm the session's identity reads first.
    two_cards_one_board = count(2)
    twenty_four_cards_twelve_boards = count(24)

    assert twenty_four_cards_twelve_boards == two_cards_one_board
    # The membership, the total, the page, the labels and the checklist progress.
    assert twenty_four_cards_twelve_boards == 5
