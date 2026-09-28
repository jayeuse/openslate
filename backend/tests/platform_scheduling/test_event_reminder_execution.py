"""Author-set event reminders notify every Board reader before each occurrence."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.models import AccessLevel
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import router as event_router
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.platform.scheduling.materializer import materialize_event_reminders
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)
from app.systems.platform.scheduling.reminder_execution import (
    claim_due_reminder_work,
    finalize_reminder_claim,
)
from tests.boards.support import client, grant, member, project_board

pytestmark = pytest.mark.integration

START = datetime(2027, 3, 1, 9, 0, tzinfo=UTC)


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _weekly_event(db: Session, board, author, *, reminders: list[str]) -> BoardEvent:
    response = client(db, author, event_router).post(
        f"/api/boards/{board.id}/events",
        json={
            "board_revision": board.revision,
            "title": "Stock count",
            "all_day": False,
            "start_at": _iso(START),
            "end_at": _iso(START + timedelta(hours=1)),
            "timezone_name": "UTC",
            "recurrence": "weekly",
            "repeat_until": (START + timedelta(weeks=4)).date().isoformat(),
            "reminders": reminders,
        },
    )
    assert response.status_code == 201, response.text
    event = db.get(BoardEvent, response.json()["id"])
    assert event is not None
    return event


def _work(db: Session, event: BoardEvent) -> list[ScheduledWork]:
    return list(
        db.scalars(
            select(ScheduledWork)
            .join(BoardEventReminder, BoardEventReminder.id == ScheduledWork.reminder_id)
            .where(
                ScheduledWork.kind == WorkKind.EVENT_REMINDER,
                BoardEventReminder.event_id == event.id,
            )
            .order_by(ScheduledWork.occurrence_start_at)
        )
    )


def _deliver(db: Session, at: datetime) -> list[object]:
    delivered: list[object] = []
    for claim in claim_due_reminder_work(db, now=at):
        delivered.extend(finalize_reminder_claim(db, claim, now=at))
    return delivered


def test_a_weekly_reminder_notifies_every_reader_before_each_occurrence(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author, reader, outsider = member(db), member(db), member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    grant(db, board, [reader], AccessLevel.READ)
    event = _weekly_event(db, board, author, reminders=["1d"])

    before_first = START - timedelta(days=3)
    materialize_event_reminders(db, now=before_first)
    [first] = _work(db, event)
    assert first.occurrence_start_at == START
    assert first.scheduled_for == START - timedelta(days=1)
    assert materialize_event_reminders(db, now=before_first) == []

    assert _deliver(db, START - timedelta(days=2)) == []
    notices = _deliver(db, START - timedelta(days=1))
    recipients = set(
        db.scalars(
            select(InAppNotification.recipient_id).where(InAppNotification.work_id == first.id)
        )
    )
    assert len(notices) == len(recipients)
    assert {author.id, reader.id} <= recipients and outsider.id not in recipients
    db.flush()
    db.refresh(first)
    assert first.state == WorkState.SUCCEEDED

    materialize_event_reminders(db, now=START - timedelta(days=1))
    second = _work(db, event)[1]
    assert second.occurrence_start_at == START + timedelta(weeks=1)
    assert second.scheduled_for == START + timedelta(weeks=1) - timedelta(days=1)
    assert _deliver(db, second.scheduled_for)
    assert (
        set(
            db.scalars(
                select(InAppNotification.recipient_id).where(InAppNotification.work_id == second.id)
            )
        )
        == recipients
    )


def test_changing_the_time_requeues_and_archive_clears_pending_occurrences(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    event = _weekly_event(db, board, author, reminders=["start", "15m"])
    now = START - timedelta(days=2)
    materialize_event_reminders(db, now=now)
    assert len(_work(db, event)) == 2

    api = client(db, author, event_router)
    db.refresh(board)
    moved = api.patch(
        f"/api/boards/{board.id}/events/{event.id}",
        json={
            "board_revision": board.revision,
            "event_revision": event.revision,
            "start_at": _iso(START + timedelta(hours=2)),
            "end_at": _iso(START + timedelta(hours=3)),
            "reminders": ["start"],
        },
    )
    assert moved.status_code == 200, moved.text
    assert _work(db, event) == []
    materialize_event_reminders(db, now=now)
    [queued] = _work(db, event)
    assert queued.occurrence_start_at == START + timedelta(hours=2)
    assert queued.scheduled_for == START + timedelta(hours=2)

    db.refresh(board)
    db.refresh(event)
    archived = api.post(
        f"/api/boards/{board.id}/events/{event.id}/archive",
        json={"board_revision": board.revision, "event_revision": event.revision},
    )
    assert archived.status_code == 200
    assert _work(db, event) == []
    assert materialize_event_reminders(db, now=now) == []


def test_a_reminder_for_a_removed_occurrence_is_canceled_at_delivery(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    event = _weekly_event(db, board, author, reminders=["start"])
    materialize_event_reminders(db, now=START - timedelta(days=1))
    [work] = _work(db, event)
    event.start_at = START + timedelta(minutes=30)
    event.end_at = START + timedelta(hours=2)
    db.flush()

    assert _deliver(db, START) == []
    db.flush()
    db.refresh(work)
    assert work.state == WorkState.CANCELED
    assert work.failure_code == "source_unavailable"


def test_readers_cannot_set_reminders_and_timings_are_distinct(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author, reader = member(db), member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    grant(db, board, [reader], AccessLevel.READ)
    payload = {
        "board_revision": board.revision,
        "title": "Review",
        "all_day": True,
        "start_date": "2027-03-01",
        "end_date": "2027-03-01",
        "timezone_name": "UTC",
        "reminders": ["1d"],
    }
    assert (
        client(db, reader, event_router)
        .post(f"/api/boards/{board.id}/events", json=payload)
        .status_code
        == 403
    )
    assert (
        client(db, author, event_router)
        .post(f"/api/boards/{board.id}/events", json={**payload, "reminders": ["1d", "1d"]})
        .status_code
        == 422
    )
    created = client(db, author, event_router).post(f"/api/boards/{board.id}/events", json=payload)
    assert created.status_code == 201
    shown = client(db, reader, event_router).get(
        f"/api/boards/{board.id}/events/{created.json()['id']}"
    )
    assert shown.json()["reminders"] == ["1d"]
