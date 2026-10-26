"""My calendar's one read of event occurrences across every readable active Board."""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event as sqlalchemy_event
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.cross_board_occurrence_router import router
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardStatus
from app.systems.boards.reminder_models import BoardEventReminder
from tests.boards.support import (
    admin,
    client,
    company_board,
    department_board,
    grant,
    guest,
    member,
    project_board,
)
from tests.organization_scope_support import scoped_override
from tests.route_app_support import route_app

ROOT = "/api/boards/occurrences"
NOVEMBER = {"window_start": "2026-11-01", "window_end": "2026-11-30"}


def _add(
    db: Session, board: Board, author: User, title: str, day: date,
    last_day: date | None = None, **values: Any,
) -> BoardEvent:
    event = BoardEvent(
        org_id=board.org_id, board_id=board.id, author_id=author.id, title=title,
        all_day=True, start_date=day, end_date=last_day or day,
        **{"timezone_name": "UTC", **values},
    )
    db.add(event)
    db.flush()
    return event


def _archived(db: Session) -> Board:
    board = project_board(db)
    board.status = BoardStatus.ARCHIVED.value
    db.flush()
    return board


def _statuses(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {entry["board_id"]: entry for entry in body["boards"]}


@pytest.mark.integration
def test_admin_reads_every_active_board_in_one_sorted_page(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    actor = admin(db)
    company, department, project = company_board(db), department_board(db), project_board(db)
    archived = _archived(db)
    first, second = sorted((company, project), key=lambda board: str(board.id))
    _add(db, second, actor, "Same day later board", date(2026, 11, 3))
    _add(db, first, actor, "Same day first board", date(2026, 11, 3))
    _add(db, department, actor, "Department review", date(2026, 11, 2))
    _add(db, archived, actor, "Archived review", date(2026, 11, 2))
    _add(db, project, actor, "Project next", date(2026, 12, 9))
    db.commit()

    response = client(db, actor, router).get(ROOT, params=NOVEMBER)

    assert response.status_code == 200, response.text
    body = response.json()
    assert [entry["board_id"] for entry in body["boards"]] == sorted(
        str(board.id) for board in (company, department, project)
    )
    assert [(item["date"], item["board"]["id"]) for item in body["items"]] == [
        ("2026-11-02", str(department.id)),
        ("2026-11-03", str(first.id)),
        ("2026-11-03", str(second.id)),
    ]
    assert body["items"][0]["board"] == {
        "id": str(department.id),
        "name": department.name,
        "scope": "department",
        "department_id": str(department.department_id),
    }
    assert body["items"][0]["event"]["board_revision"] == department.revision
    statuses = _statuses(body)
    assert statuses[str(project.id)]["revision"] == project.revision
    assert statuses[str(project.id)]["status"] == "ok"
    assert statuses[str(project.id)]["next_occurrence"]["date"] == "2026-12-09"
    assert statuses[str(company.id)]["next_occurrence"] is None

    page = client(db, actor, router).get(ROOT, params={**NOVEMBER, "limit": 1, "offset": 1})
    assert page.json()["pagination"] == {
        "limit": 1, "offset": 1, "count": 1, "total": 3, "has_more": True,
    }
    assert page.json()["items"][0]["board"]["id"] == str(first.id)
    searched = client(db, actor, router).get(ROOT, params={**NOVEMBER, "search": "same DAY"})
    assert {item["board"]["id"] for item in searched.json()["items"]} == {
        str(company.id), str(project.id),
    }


@pytest.mark.integration
def test_members_and_guests_read_only_the_boards_they_can_read(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = admin(db)
    reader, visitor = member(db), guest(db)
    company, readable, hidden = company_board(db), project_board(db), project_board(db)
    department = department_board(db)
    grant(db, readable, [reader], AccessLevel.READ)
    grant(db, department, [reader], AccessLevel.WRITE)
    grant(db, readable, [visitor], AccessLevel.WRITE)
    for board in (company, readable, hidden, department):
        _add(db, board, owner, f"Event on {board.name}", date(2026, 11, 5))
    db.commit()

    seen = client(db, reader, router).get(ROOT, params=NOVEMBER).json()
    guest_seen = client(db, visitor, router).get(ROOT, params=NOVEMBER).json()

    assert set(_statuses(seen)) == {str(company.id), str(readable.id), str(department.id)}
    assert {item["board"]["id"] for item in seen["items"]} == set(_statuses(seen))
    # A guest's write grant still only reads; the read itself never needs more.
    assert set(_statuses(guest_seen)) == {str(company.id), str(readable.id)}
    assert {item["board"]["id"] for item in guest_seen["items"]} == set(_statuses(guest_seen))


@pytest.mark.integration
def test_refused_board_ids_are_unavailable_without_saying_why(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = admin(db)
    reader = member(db)
    readable, unreadable, archived = project_board(db), project_board(db), _archived(db)
    grant(db, readable, [reader], AccessLevel.READ)
    grant(db, archived, [reader], AccessLevel.READ)
    for board in (readable, unreadable, archived):
        _add(db, board, owner, "Planning", date(2026, 11, 5))
    db.commit()
    unknown = uuid7()
    requested = [readable.id, unknown, archived.id, readable.id, unreadable.id]

    response = client(db, reader, router).get(
        ROOT, params={**NOVEMBER, "board_id": [str(board_id) for board_id in requested]}
    )
    as_admin = client(db, owner, router).get(
        ROOT, params={**NOVEMBER, "board_id": [str(archived.id), str(unreadable.id)]}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert [entry["board_id"] for entry in body["boards"]] == [
        str(readable.id), str(unknown), str(archived.id), str(unreadable.id),
    ]
    refused = [{**entry, "board_id": None} for entry in body["boards"][1:]]
    assert refused == [
        {"board_id": None, "revision": None, "status": "unavailable", "next_occurrence": None}
    ] * 3
    assert {item["board"]["id"] for item in body["items"]} == {str(readable.id)}
    assert [entry["status"] for entry in as_admin.json()["boards"]] == ["unavailable", "ok"]


@pytest.mark.integration
def test_a_board_over_a_limit_or_with_an_invalid_event_reports_it_and_others_read(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    actor = admin(db)
    calm, dense, crowded = project_board(db), project_board(db), project_board(db)
    broken = project_board(db)
    _add(db, calm, actor, "Calm", date(2026, 11, 5))
    _add(db, broken, actor, "Stored before zones were checked", date(2026, 11, 5),
         timezone_name="Mars/Olympus_Mons")
    _add(db, dense, actor, "Short", date(2026, 11, 6))
    _add(db, dense, actor, "Dense recurring span", date(2026, 6, 1), date(2026, 9, 30),
         recurrence="daily", repeat_until=date(2027, 1, 30))
    for index in range(501):
        _add(db, crowded, actor, f"Crowded {index}", date(2027, 1, 1))
    db.commit()

    response = client(db, actor, router).get(
        ROOT, params={**NOVEMBER, "board_id": [
            str(calm.id), str(dense.id), str(crowded.id), str(broken.id),
        ]},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert [(entry["status"], entry["next_occurrence"]) for entry in body["boards"]] == [
        ("ok", None), ("occurrence_limit", None), ("candidate_limit", None),
        ("unavailable", None),
    ]
    assert [entry["revision"] for entry in body["boards"]] == [
        calm.revision, dense.revision, crowded.revision, None,
    ]
    assert [item["event"]["title"] for item in body["items"]] == ["Calm"]


@pytest.mark.integration
def test_window_and_page_bounds_are_validated(integration_owner_db: Session) -> None:
    db = integration_owner_db
    reader = client(db, admin(db), router)

    # 2026-11-01 to 2026-12-12 is 42 inclusive days.
    assert reader.get(ROOT, params={"window_start": "2026-11-01",
                                    "window_end": "2026-12-13"}).status_code == 422
    assert reader.get(ROOT, params={"window_start": "2026-11-01",
                                    "window_end": "2026-12-12"}).status_code == 200
    # The merged page keeps the shared list limit.
    assert reader.get(ROOT, params={**NOVEMBER, "limit": 101}).status_code == 422
    accepted = reader.get(ROOT, params={**NOVEMBER, "limit": 100})
    assert accepted.json()["pagination"]["limit"] == 100
    many = {**NOVEMBER, "board_id": [str(uuid7()) for _ in range(101)]}
    assert reader.get(ROOT, params=many).status_code == 422
    assert reader.get(ROOT, params={**NOVEMBER, "board_id": "not-a-board"}).status_code == 422


@pytest.mark.integration
def test_the_cross_board_path_is_not_captured_by_board_id_routes(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    actor = admin(db)
    board = company_board(db)
    _add(db, board, actor, "Routed", date(2026, 11, 5))
    db.commit()
    application = route_app()
    application.dependency_overrides[get_current_user] = scoped_override(lambda: actor)
    application.dependency_overrides[get_db] = lambda: db

    with TestClient(application) as real_app:
        response = real_app.get(ROOT, params=NOVEMBER)

    assert response.status_code == 200, response.text
    assert [item["event"]["title"] for item in response.json()["items"]] == ["Routed"]


@contextmanager
def _statements(db: Session) -> Iterator[list[str]]:
    executed: list[str] = []
    engine = db.get_bind().engine

    def record(_connection: object, _cursor: object, statement: str, *_args: object) -> None:
        # Binding the transaction to its organization is infrastructure, not route work.
        if "set_config('openslate.org_id'" not in statement:
            executed.append(" ".join(statement.split())[:160])

    sqlalchemy_event.listen(engine, "before_cursor_execute", record)
    try:
        yield executed
    finally:
        sqlalchemy_event.remove(engine, "before_cursor_execute", record)


def _count(db: Session, actor: User, board_ids: list[UUID]) -> int:
    reader = client(db, actor, router)
    params = {**NOVEMBER, "board_id": [str(board_id) for board_id in board_ids]}
    with _statements(db) as executed:
        response = reader.get(ROOT, params=params)
    assert response.status_code == 200, response.text
    assert len(response.json()["boards"]) == len(board_ids)
    return len(executed)


@pytest.mark.integration
def test_the_statement_count_does_not_grow_with_the_number_of_boards(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = admin(db)
    reader = member(db)
    boards = [project_board(db) for _ in range(12)]
    for board in boards:
        grant(db, board, [reader], AccessLevel.READ)
        for day in (3, 17):
            event = _add(db, board, owner, "Weekly sync", date(2026, 11, day))
            db.add(BoardEventReminder(org_id=board.org_id, board_id=board.id,
                                      event_id=event.id, timing="1d"))
    db.commit()

    _count(db, reader, [boards[0].id])  # Warm the session's identity reads first.
    one = _count(db, reader, [boards[0].id])
    twelve = _count(db, reader, [board.id for board in boards])

    assert twelve == one
    # The membership, the Boards, every Board's candidates, and every reminder.
    assert twelve <= 4
