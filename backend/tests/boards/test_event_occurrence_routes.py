"""Calendar HTTP paging, DST, and explicit expansion/candidate limits."""

from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import router
from app.systems.boards.models import Board
from tests.boards.support import board_group


def _actor(db: Session) -> User:
    role = "member"
    db.flush()
    user_id = uuid7()
    actor = User(
        id=user_id,
        email=f"calendar-{user_id.hex}@example.test",
        username=f"calendar_{user_id.hex[:12]}",
        status="active",
        role=role,
    )
    db.add(actor)
    db.flush()
    return actor


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


@pytest.mark.integration
def test_event_occurrence_window_paging_dst_and_explicit_density_limits(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    board = Board(scope="project", name=f"Calendar {uuid7().hex[:12]}", status="active")
    db.add(board)
    db.flush()
    board_group(db, board, [owner], AccessLevel.WRITE)
    spring_start = datetime(2026, 3, 7, 7, 30, tzinfo=UTC)
    spring = BoardEvent(
        board_id=board.id,
        author_id=owner.id,
        title="Spring clock",
        all_day=False,
        start_at=spring_start,
        end_at=spring_start + timedelta(hours=1),
        timezone_name="America/New_York",
        recurrence="daily",
        repeat_until=date(2026, 3, 9),
    )
    db.add(spring)
    db.add(
        BoardEvent(
            board_id=board.id,
            author_id=owner.id,
            title="All day",
            all_day=True,
            start_date=date(2026, 3, 8),
            end_date=date(2026, 3, 8),
            timezone_name="America/New_York",
        )
    )
    fall_start = datetime(2026, 10, 31, 5, 30, tzinfo=UTC)
    db.add(
        BoardEvent(
            board_id=board.id,
            author_id=owner.id,
            title="Fall clock",
            all_day=False,
            start_at=fall_start,
            end_at=fall_start + timedelta(hours=1),
            timezone_name="America/New_York",
            recurrence="daily",
            repeat_until=date(2026, 11, 2),
        )
    )
    monthly_event = BoardEvent(
        board_id=board.id,
        author_id=owner.id,
        title="Monthly 31st",
        all_day=True,
        start_date=date(2026, 1, 31),
        end_date=date(2026, 1, 31),
        timezone_name="UTC",
        recurrence="monthly",
        repeat_until=date(2026, 4, 30),
    )
    db.add(monthly_event)
    db.commit()
    root = f"/api/boards/{board.id}/events/occurrences"
    client = _client(db, owner)
    spring_window = "window_start=2026-03-07&window_end=2026-03-09"
    page = client.get(f"{root}?{spring_window}&limit=2&offset=1")
    assert page.status_code == 200
    assert page.json()["pagination"] == {
        "limit": 2,
        "offset": 1,
        "count": 2,
        "total": 4,
        "has_more": True,
    }
    all_spring = client.get(f"{root}?{spring_window}").json()["items"]
    assert [item["start"] for item in all_spring if item["event_id"] == str(spring.id)] == [
        "2026-03-07T07:30:00Z",
        "2026-03-08T07:30:00Z",
        "2026-03-09T06:30:00Z",
    ]
    assert client.get(f"{root}?window_start=2026-03-01&window_end=2026-04-12").status_code == 422
    fall_items = client.get(f"{root}?window_start=2026-10-31&window_end=2026-11-02").json()
    assert [item["start"] for item in fall_items["items"]] == [
        "2026-10-31T05:30:00Z",
        "2026-11-01T05:30:00Z",
        "2026-11-02T06:30:00Z",
    ]
    monthly = client.get(f"{root}?window_start=2026-02-25&window_end=2026-04-05").json()
    assert [
        item["date"] for item in monthly["items"] if item["event_id"] == str(monthly_event.id)
    ] == ["2026-03-31"]

    db.add(
        BoardEvent(
            board_id=board.id,
            author_id=owner.id,
            title="Dense recurring span",
            all_day=True,
            start_date=date(2026, 1, 1),
            end_date=date(2026, 4, 10),
            timezone_name="UTC",
            recurrence="daily",
            repeat_until=date(2026, 5, 30),
        )
    )
    db.commit()
    dense = client.get(f"{root}?window_start=2026-04-01&window_end=2026-05-12")
    assert dense.status_code == 409
    assert dense.json()["detail"]["code"] == "event_occurrence_limit"

    db.add_all(
        BoardEvent(
            board_id=board.id,
            author_id=owner.id,
            title=f"Extra {index}",
            all_day=True,
            start_date=date(2027, 1, 1),
            end_date=date(2027, 1, 1),
            timezone_name="UTC",
        )
        for index in range(496)
    )
    db.commit()
    assert (
        db.scalar(
            select(func.count(BoardEvent.id)).where(BoardEvent.board_id == board.id)
        )
        == 501
    )
    capped = client.get(f"{root}?window_start=2026-12-01&window_end=2026-12-01")
    assert capped.status_code == 409
    assert capped.json()["detail"]["code"] == "event_candidate_limit"


@pytest.mark.integration
def test_event_occurrence_search_escapes_like_wildcards_and_filters_before_count(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    board = Board(scope="project", name=f"Search calendar {uuid7().hex[:12]}", status="active")
    db.add(board)
    db.flush()
    board_group(db, board, [owner], AccessLevel.READ)
    visible_literal = BoardEvent(
        board_id=board.id,
        author_id=owner.id,
        title="Budget 100%_ signed",
        all_day=True,
        start_date=date(2026, 7, 4),
        end_date=date(2026, 7, 4),
        timezone_name="UTC",
    )
    visible_similar = BoardEvent(
        board_id=board.id,
        author_id=owner.id,
        title="Budget 100XY signed",
        all_day=True,
        start_date=date(2026, 7, 5),
        end_date=date(2026, 7, 5),
        timezone_name="UTC",
    )
    db.add_all((visible_literal, visible_similar))
    db.commit()

    root = f"/api/boards/{board.id}/events/occurrences"
    client = _client(db, owner)
    params = {"window_start": "2026-07-01", "window_end": "2026-07-10"}
    literal = client.get(root, params={**params, "search": "100%_"})
    assert literal.status_code == 200, literal.text
    assert literal.json()["pagination"]["total"] == 1
    assert literal.json()["items"][0]["event_id"] == str(visible_literal.id)

    underscore = client.get(root, params={**params, "search": "_"})
    assert underscore.status_code == 200
    assert underscore.json()["pagination"]["total"] == 1
    assert underscore.json()["items"][0]["event_id"] == str(visible_literal.id)

    broad = client.get(root, params={**params, "search": "Budget"})
    assert broad.status_code == 200
    assert broad.json()["pagination"]["total"] == 2
    assert {item["event_id"] for item in broad.json()["items"]} == {
        str(visible_literal.id),
        str(visible_similar.id),
    }


@pytest.mark.integration
def test_timed_event_reads_and_occurrences_survive_non_utc_postgres_session(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    board = Board(scope="project", name=f"Offset calendar {uuid7().hex[:12]}", status="active")
    db.add(board)
    db.flush()
    board_group(db, board, [owner], AccessLevel.READ)
    event = BoardEvent(
        board_id=board.id,
        author_id=owner.id,
        title="New York morning",
        all_day=False,
        start_at=datetime(2026, 3, 7, 7, 30, tzinfo=UTC),
        end_at=datetime(2026, 3, 7, 8, 30, tzinfo=UTC),
        timezone_name="America/New_York",
        recurrence="daily",
        repeat_until=date(2026, 3, 9),
    )
    db.add(event)
    db.commit()
    board_id, event_id = board.id, event.id

    db.connection().execute(text("SET LOCAL TIME ZONE 'Asia/Manila'"))
    db.expire_all()
    loaded = db.get(BoardEvent, event_id)
    assert loaded is not None
    assert loaded.start_at.utcoffset() == timedelta(hours=8)

    client = _client(db, owner)
    root = f"/api/boards/{board_id}/events"
    detail = client.get(f"{root}/{event_id}")
    assert detail.status_code == 200
    assert detail.json()["start_at"] == "2026-03-07T07:30:00Z"
    listed = client.get(root)
    assert listed.status_code == 200
    assert listed.json()["pagination"]["total"] == 1
    assert listed.json()["items"][0]["start_at"] == "2026-03-07T07:30:00Z"

    occurrences = client.get(f"{root}/occurrences?window_start=2026-03-07&window_end=2026-03-09")
    assert occurrences.status_code == 200
    assert occurrences.json()["pagination"]["total"] == 3
    assert [item["start"] for item in occurrences.json()["items"]] == [
        "2026-03-07T07:30:00Z",
        "2026-03-08T07:30:00Z",
        "2026-03-09T06:30:00Z",
    ]
