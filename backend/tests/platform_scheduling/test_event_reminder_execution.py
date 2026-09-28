"""Author-set event reminders notify every Board reader before each occurrence."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.models import AccessLevel
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import router as event_router
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.platform.scheduling import reminder_execution
from app.systems.platform.scheduling.materializer import materialize_event_reminders
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)
from app.systems.platform.scheduling.reminder_execution import (
    claim_due_reminder_work,
    execute_due_reminders,
    finalize_reminder_claim,
)
from tests.boards.support import board_group, client, grant, member, project_board

pytestmark = pytest.mark.integration

START = datetime(2027, 3, 1, 9, 0, tzinfo=UTC)


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _timed_event(
    db: Session,
    board,
    author,
    *,
    reminders: list[str],
    weekly: bool = True,
    repeat_weeks: int = 4,
) -> BoardEvent:
    payload: dict[str, object] = {
        "board_revision": board.revision,
        "title": "Stock count",
        "all_day": False,
        "start_at": _iso(START),
        "end_at": _iso(START + timedelta(hours=1)),
        "timezone_name": "UTC",
        "reminders": reminders,
        "recurrence": "weekly" if weekly else "none",
    }
    if weekly:
        payload["repeat_until"] = (START + timedelta(weeks=repeat_weeks)).date().isoformat()
    response = client(db, author, event_router).post(f"/api/boards/{board.id}/events", json=payload)
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
    new_reader = member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    reader_group = board_group(db, board, [reader], AccessLevel.READ)
    event = _timed_event(db, board, author, reminders=["1d"])

    before_first = START - timedelta(days=3)
    materialize_event_reminders(db, now=before_first)
    [first] = _work(db, event)
    assert first.occurrence_start_at == START
    assert first.scheduled_for == START - timedelta(days=1)
    assert materialize_event_reminders(db, now=before_first) == []

    assert _deliver(db, START - timedelta(days=2)) == []
    db.delete(reader_group)
    grant(db, board, [new_reader], AccessLevel.READ)
    db.flush()
    late_delivery = first.scheduled_for + timedelta(minutes=10)
    notices = _deliver(db, late_delivery)
    recipients = set(
        db.scalars(
            select(InAppNotification.recipient_id).where(InAppNotification.work_id == first.id)
        )
    )
    assert len(notices) == len(recipients)
    assert {author.id, new_reader.id} <= recipients
    assert reader.id not in recipients and outsider.id not in recipients
    assert _deliver(db, late_delivery) == []
    db.flush()
    db.refresh(first)
    assert first.state == WorkState.SUCCEEDED

    materialize_event_reminders(db, now=late_delivery)
    second = _work(db, event)[1]
    assert second.occurrence_start_at == START + timedelta(weeks=1)
    assert second.scheduled_for == START + timedelta(weeks=1) - timedelta(days=1)
    assert _deliver(db, second.scheduled_for)
    assert set(
        db.scalars(
            select(InAppNotification.recipient_id).where(InAppNotification.work_id == second.id)
        )
    ) == {author.id, new_reader.id}


def test_changing_the_time_requeues_and_archive_clears_pending_occurrences(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    event = _timed_event(db, board, author, reminders=["start", "15m"])
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
    event = _timed_event(db, board, author, reminders=["start"])
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


def test_a_claimed_old_occurrence_does_not_hide_an_edited_earlier_occurrence(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    event = _timed_event(db, board, author, reminders=["1d"])
    old_due = START - timedelta(days=1)
    materialize_event_reminders(db, now=old_due - timedelta(hours=1))
    [old_work] = _work(db, event)
    [claim] = claim_due_reminder_work(db, now=old_due)

    db.refresh(board)
    db.refresh(event)
    moved = client(db, author, event_router).patch(
        f"/api/boards/{board.id}/events/{event.id}",
        json={
            "board_revision": board.revision,
            "event_revision": event.revision,
            "start_at": _iso(START - timedelta(minutes=5)),
            "end_at": _iso(START + timedelta(minutes=55)),
        },
    )
    assert moved.status_code == 200, moved.text
    assert finalize_reminder_claim(db, claim, now=old_due + timedelta(minutes=1)) == []
    db.flush()
    db.refresh(old_work)
    assert old_work.state == WorkState.CANCELED

    new_ids = materialize_event_reminders(db, now=old_due + timedelta(minutes=1))
    queued = _work(db, event)
    assert len(queued) == 2
    new_work = next(work for work in queued if work.id != old_work.id)
    assert new_ids == [new_work.id]
    assert new_work.occurrence_start_at == START - timedelta(minutes=5)
    assert new_work.scheduled_for == old_due - timedelta(minutes=5)


def test_a_new_start_reminder_is_delivered_at_the_fifteen_minute_boundary(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author, reader, outsider = member(db), member(db), member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    event = _timed_event(db, board, author, reminders=["start"], weekly=False)
    late_delivery = START + timedelta(minutes=15)

    work_ids = materialize_event_reminders(db, now=late_delivery)
    [work] = _work(db, event)
    assert work.id in work_ids
    assert work.occurrence_start_at == START
    assert work.scheduled_for == START

    # The audience is resolved after materialization, at delivery time.
    grant(db, board, [reader], AccessLevel.READ)
    delivered = _deliver(db, late_delivery)
    recipients = set(
        db.scalars(
            select(InAppNotification.recipient_id).where(InAppNotification.work_id == work.id)
        )
    )
    assert len(delivered) == 2
    assert recipients == {author.id, reader.id}
    assert outsider.id not in recipients
    assert _deliver(db, late_delivery) == []

    db.flush()
    db.refresh(work)
    assert work.state == WorkState.SUCCEEDED
    assert materialize_event_reminders(db, now=late_delivery + timedelta(seconds=1)) == []
    assert _work(db, event) == [work]


@pytest.mark.parametrize("completed_recurs", [False, True])
def test_completed_reminder_cannot_hide_another_due_reminder_from_a_bounded_batch(
    integration_owner_db: Session, completed_recurs: bool
) -> None:
    db = integration_owner_db
    author = member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    completed = _timed_event(
        db, board, author, reminders=["start"], weekly=completed_recurs, repeat_weeks=0
    )
    materialize_event_reminders(db, now=START, limit=1)
    assert _deliver(db, START)
    [completed_work] = _work(db, completed)
    db.flush()
    db.refresh(completed_work)
    assert completed_work.state == WorkState.SUCCEEDED

    due = _timed_event(db, board, author, reminders=["start"], weekly=False)
    queued_ids = materialize_event_reminders(db, now=START + timedelta(minutes=1), limit=1)

    [due_work] = _work(db, due)
    assert queued_ids == [due_work.id]
    assert due_work.scheduled_for == START
    assert _work(db, completed) == [completed_work]


def test_daily_one_day_reminder_queues_the_next_day_at_the_prior_occurrence_start(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    event = _timed_event(db, board, author, reminders=["1d"])
    event.recurrence = "daily"
    event.repeat_until = (START + timedelta(days=2)).date()
    db.flush()

    first_due = START - timedelta(days=1)
    materialize_event_reminders(db, now=first_due)
    assert _deliver(db, first_due)

    next_ids = materialize_event_reminders(db, now=first_due + timedelta(minutes=1))
    first, second = _work(db, event)
    assert next_ids == [second.id]
    assert first.occurrence_start_at == START
    assert second.occurrence_start_at == START + timedelta(days=1)
    assert second.scheduled_for == START


def test_a_queued_reminder_older_than_fifteen_minutes_is_canceled(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    event = _timed_event(db, board, author, reminders=["start"], weekly=False)
    materialize_event_reminders(db, now=START - timedelta(hours=1))
    [work] = _work(db, event)

    delivered = _deliver(db, START + timedelta(minutes=15, seconds=1))
    db.flush()
    db.refresh(work)

    assert delivered == []
    assert work.state == WorkState.CANCELED
    assert (
        list(db.scalars(select(InAppNotification).where(InAppNotification.work_id == work.id)))
        == []
    )


def test_a_slow_batch_uses_delivery_time_for_the_fifteen_minute_cutoff(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    author = member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    event = _timed_event(db, board, author, reminders=["start"], weekly=False)
    materialize_event_reminders(db, now=START - timedelta(hours=1))
    [work] = _work(db, event)
    db.flush()

    delivery_time = START + timedelta(minutes=15, seconds=1)
    instants = iter((START + timedelta(minutes=14), delivery_time))
    monkeypatch.setattr(reminder_execution, "utc_now", lambda: next(instants, delivery_time))
    delivered = execute_due_reminders(db.get_bind(), limit=1)
    db.expire_all()

    assert delivered == []
    assert db.get(ScheduledWork, work.id).state == WorkState.CANCELED
    assert (
        list(db.scalars(select(InAppNotification).where(InAppNotification.work_id == work.id)))
        == []
    )


def test_archived_event_cancels_a_claimed_reminder_at_delivery(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    event = _timed_event(db, board, author, reminders=["start"], weekly=False)
    materialize_event_reminders(db, now=START - timedelta(minutes=1))
    [work] = _work(db, event)
    [claim] = claim_due_reminder_work(db, now=START)
    db.flush()

    db.refresh(board)
    db.refresh(event)
    archived = client(db, author, event_router).post(
        f"/api/boards/{board.id}/events/{event.id}/archive",
        json={"board_revision": board.revision, "event_revision": event.revision},
    )
    assert archived.status_code == 200, archived.text

    delivered = finalize_reminder_claim(db, claim, now=START + timedelta(minutes=1))
    db.flush()
    db.refresh(work)

    assert delivered == []
    assert work.state == WorkState.CANCELED
    assert (
        list(db.scalars(select(InAppNotification).where(InAppNotification.work_id == work.id)))
        == []
    )


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
