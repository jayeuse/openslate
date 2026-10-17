"""Board event API: input contract, author and manager lifecycle, and revisions."""

from datetime import UTC, date, datetime, timedelta
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.event_author_router import router as author_router
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_occurrences import expand_board_event_occurrences
from app.systems.boards.event_router import router
from app.systems.boards.event_schemas import EventCreate
from app.systems.boards.models import Board
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.platform.scheduling.models import ScheduledWork, WorkKind, WorkState
from tests.boards.support import admin, client, grant, member, project_board


def _client(db: Session, actor: User) -> TestClient:
    return client(db, actor, author_router, router)


def _series(db: Session, board: Board, author: User, title: str) -> BoardEvent:
    day = date(2026, 9, 14)
    event = BoardEvent(
        org_id=board.org_id,
        board_id=board.id,
        author_id=author.id,
        title=title,
        all_day=True,
        start_date=day,
        end_date=day,
        timezone_name="UTC",
    )
    db.add(event)
    db.flush()
    return event


def _payload(revision: int, **changes: object) -> dict[str, object]:
    return {
        "board_revision": revision,
        "title": "Planning",
        "all_day": True,
        "start_date": "2026-09-14",
        "end_date": "2026-09-14",
        "timezone_name": "UTC",
        **changes,
    }


def test_event_input_rejects_temporal_ambiguity_and_unsupported_content() -> None:
    valid = _payload(1)
    assert EventCreate.model_validate(valid).reminders == []
    assert EventCreate.model_validate({**valid, "reminders": ["1d", "start"]}).reminders == [
        "1d",
        "start",
    ]
    invalid = (
        {**valid, "timezone_name": "Not/A_Zone"},
        {**valid, "start_at": "2026-09-14T08:00:00Z"},
        {**valid, "recurrence": "weekly"},
        {**valid, "recurrence": "weekly", "repeat_until": "2026-09-13"},
        {**valid, "audience": {"kind": "everyone"}},
        {**valid, "attachments": []},
        {**valid, "reminders": ["now"]},
        {**valid, "reminders": ["15m", "15m"]},
        {
            **valid,
            "all_day": False,
            "start_date": None,
            "end_date": None,
            "start_at": "2026-09-14T08:00:00",
            "end_at": "2026-09-14T09:00:00Z",
        },
        {
            **valid,
            "all_day": False,
            "start_date": None,
            "end_date": None,
            "start_at": "2026-09-14T16:00:00+08:00",
            "end_at": "2026-09-14T17:00:00+08:00",
        },
    )
    for candidate in invalid:
        with pytest.raises(ValidationError):
            EventCreate.model_validate(candidate)


@pytest.mark.parametrize(
    ("recurrence", "anchor", "end", "until", "accepted"),
    [
        ("none", "2026-01-01", "9999-12-31", None, True),
        ("daily", "2026-01-01", "2026-02-28", "9999-12-31", True),
        ("daily", "2026-01-01", "2026-03-01", "9999-12-31", False),
        ("weekly", "2026-01-01", "2027-10-21", "9999-12-31", True),
        ("weekly", "2026-01-01", "2027-10-22", "9999-12-31", False),
        ("daily", "2026-01-01", "2026-01-01", "9999-12-31", True),
        ("weekly", "2026-01-01", "2026-01-01", "9999-12-31", True),
        ("monthly", "2026-01-31", "2026-01-31", "9999-12-31", True),
        ("daily", "2026-01-01", "2028-01-01", "2026-04-10", True),
        ("daily", "2026-01-01", "2028-01-01", "2026-04-11", False),
        ("weekly", "2026-01-01", "2028-01-01", "2027-11-25", True),
        ("weekly", "2026-01-01", "2028-01-01", "2027-12-02", False),
        # The 31st occurs seven times a year; the hundredth start is March 2034.
        ("monthly", "2020-01-31", "2035-01-31", "2034-03-31", True),
        ("monthly", "2020-01-31", "2035-01-31", "2034-05-30", True),
        ("monthly", "2020-01-31", "2035-01-31", "2034-05-31", False),
        ("monthly", "9990-01-31", "9999-12-31", "9999-12-31", True),
    ],
)
def test_all_day_series_admission_preserves_bounded_calendar_reads(
    recurrence: str, anchor: str, end: str, until: str | None, accepted: bool
) -> None:
    payload = _payload(
        1, start_date=anchor, end_date=end, recurrence=recurrence, repeat_until=until
    )
    if not accepted:
        with pytest.raises(ValidationError, match="100 occurrences"):
            EventCreate.model_validate(payload)
        return

    definition = EventCreate.model_validate(payload)
    assert definition.start_date == date.fromisoformat(anchor)


@pytest.mark.parametrize(
    ("start", "end", "zone", "window", "until", "accepted"),
    [
        (
            "2026-01-01T00:00:00Z", "2026-02-27T00:00:00Z",
            "UTC", "2026-03-01", "9999-12-31", True,
        ),
        (
            "2026-01-01T00:00:00Z", "2026-02-27T00:00:00.000001Z",
            "UTC", "2026-03-01", "9999-12-31", False,
        ),
        (
            "2026-01-01T23:59:59.999999Z", "2026-02-27T00:00:00Z",
            "UTC", "2026-03-01", "9999-12-31", True,
        ),
        (
            "2026-01-01T23:59:59.999999Z", "2026-02-27T00:00:00.000001Z",
            "UTC", "2026-03-01", "9999-12-31", False,
        ),
        (
            "2026-01-01T07:30:00Z", "2026-02-26T07:30:00Z",
            "America/New_York", "2026-03-01", "9999-12-31", True,
        ),
        (
            "2026-09-01T05:30:00Z", "2026-10-27T05:30:00Z",
            "America/New_York", "2026-11-01", "9999-12-31", True,
        ),
        (
            "2011-10-01T09:45:00Z", "2011-11-26T09:45:00Z",
            "Pacific/Apia", "2011-12-01", "9999-12-31", True,
        ),
        (
            "2026-01-01T23:30:00Z", "2026-04-11T23:30:00Z",
            "Pacific/Kiritimati", "2026-04-01", "2026-04-11", True,
        ),
        (
            "2026-01-01T23:30:00Z", "2026-04-11T23:30:00Z",
            "Pacific/Kiritimati", "2026-04-01", "2026-04-12", False,
        ),
    ],
)
def test_timed_series_admission_keeps_reader_complete_across_clock_boundaries(
    start: str, end: str, zone: str, window: str, until: str, accepted: bool
) -> None:
    payload = _payload(
        1, all_day=False, start_date=None, end_date=None, start_at=start, end_at=end,
        timezone_name=zone, recurrence="daily", repeat_until=until,
    )
    if not accepted:
        with pytest.raises(ValidationError, match="100 occurrences"):
            EventCreate.model_validate(payload)
        return

    definition = EventCreate.model_validate(payload)
    event = BoardEvent(
        id=UUID(int=1), **definition.model_dump(exclude={"board_revision", "reminders"})
    )
    first = date.fromisoformat(window)
    result = expand_board_event_occurrences(event, first, first + timedelta(days=41))
    assert result.occurrences
    assert result.truncated is False


@pytest.mark.integration
def test_series_save_admission_is_atomic_and_stored_series_remain_correctable(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    unrelated = _series(db, board, author, "Other calendar event")
    unrelated.start_date = unrelated.end_date = date(2026, 4, 5)
    db.commit()
    api = _client(db, author)
    root = f"/api/boards/{board.id}/events"
    span = {"start_date": "2026-01-01", "end_date": "2026-04-10"}
    created = api.post(root, json=_payload(1, **span, reminders=["start"]))
    assert created.status_code == 201
    event_id = created.json()["id"]
    detail_url = f"{root}/{event_id}"
    before = api.get(detail_url).json()
    reminder = db.scalars(
        select(BoardEventReminder).where(BoardEventReminder.event_id == UUID(event_id))
    ).one()
    reminder_id = reminder.id
    instant = datetime(2026, 1, 1, tzinfo=UTC)
    work = ScheduledWork(
        org_id=board.org_id, kind=WorkKind.EVENT_REMINDER, reminder_id=reminder_id,
        occurrence_start_at=instant, scheduled_for=instant, next_attempt_at=instant,
    )
    db.add(work)
    db.commit()
    work_id = work.id

    refused_create = api.post(
        root, json=_payload(
            2, **span, recurrence="daily", repeat_until="2026-12-31", reminders=["15m"]
        ),
    )
    current = api.get(detail_url).json()
    refused_patch = api.patch(
        detail_url,
        json={
            "board_revision": current["board_revision"], "event_revision": 1,
            "title": "Changed title", "recurrence": "daily", "repeat_until": "2026-12-31",
            "reminders": ["15m"],
        },
    )
    assert (refused_create.status_code, refused_patch.status_code) == (422, 422)
    db.expire_all()
    assert api.get(detail_url).json() == before
    assert api.get(root).json()["pagination"]["total"] == 2
    assert list(db.execute(
        select(BoardEventReminder.id, BoardEventReminder.timing).where(
            BoardEventReminder.board_id == board.id
        )
    )) == [(reminder_id, "start")]
    assert list(db.execute(
        select(ScheduledWork.id, ScheduledWork.state).where(
            ScheduledWork.reminder_id == reminder_id
        )
    )) == [(work_id, WorkState.PENDING)]
    window = {"window_start": "2026-04-01", "window_end": "2026-05-12"}
    calendar = api.get(f"{root}/occurrences", params=window)
    assert calendar.status_code == 200
    assert {item["event_id"] for item in calendar.json()["items"]} == {
        event_id, str(unrelated.id)
    }

    stored = _series(db, board, author, "Stored recurring span")
    stored.start_date, stored.end_date = date(2026, 1, 1), date(2026, 4, 10)
    stored.recurrence, stored.repeat_until = "daily", date(2026, 12, 31)
    db.commit()
    assert api.get(f"{root}/{stored.id}").status_code == 200
    listed = api.get(root)
    assert listed.status_code == 200
    assert str(stored.id) in {item["id"] for item in listed.json()["items"]}
    corrected = api.patch(
        f"{root}/{stored.id}",
        json={"board_revision": 2, "event_revision": 1, "end_date": "2026-01-01"},
    )
    assert corrected.status_code == 200
    assert corrected.json()["event_revision"] == 2
    calendar = api.get(f"{root}/occurrences", params=window)
    assert calendar.status_code == 200
    assert calendar.json()["pagination"]["total"] == 44


@pytest.mark.integration
def test_event_revisioned_author_and_manager_lifecycle(
    integration_owner_db: Session, monkeypatch
) -> None:
    db = integration_owner_db
    editor, manager, other, reader = member(db), member(db), member(db), member(db)
    board = project_board(db)
    grant(db, board, [editor, other], AccessLevel.WRITE)
    grant(db, board, [manager], AccessLevel.MANAGE)
    grant(db, board, [reader], AccessLevel.READ)
    db.commit()
    root = f"/api/boards/{board.id}/events"
    editor_client, manager_client = _client(db, editor), _client(db, manager)

    assert _client(db, reader).post(root, json=_payload(1)).status_code == 403
    assert _client(db, other).post(root, json=_payload(1)).status_code == 201
    first = editor_client.post(root, json=_payload(2))
    assert first.status_code == 201
    event_id = first.json()["id"]
    assert first.json() == {"id": event_id, "event_revision": 1, "board_revision": 3}
    assert first.headers["Location"] == f"{root}/{event_id}"
    assert _client(db, reader).get(first.headers["Location"]).status_code == 200
    stale = editor_client.patch(
        f"{root}/{event_id}", json={"board_revision": 2, "event_revision": 1, "title": "Stale"}
    )
    assert stale.json()["detail"]["code"] == "stale_board_revision"
    own = editor_client.patch(
        f"{root}/{event_id}",
        json={"board_revision": 3, "event_revision": 1, "title": "Updated by author"},
    )
    assert own.status_code == 200
    assert own.json() == {"id": event_id, "event_revision": 2, "board_revision": 4}
    stale_event = editor_client.patch(
        f"{root}/{event_id}", json={"board_revision": 4, "event_revision": 1, "title": "Old"}
    )
    assert stale_event.json()["detail"]["code"] == "stale_event_revision"
    not_mine = _client(db, other).patch(
        f"{root}/{event_id}", json={"board_revision": 4, "event_revision": 2, "title": "No"}
    )
    assert not_mine.status_code == 403
    managed = manager_client.patch(
        f"{root}/{event_id}", json={"board_revision": 4, "event_revision": 2, "title": "Managed"}
    )
    assert managed.status_code == 200 and managed.json()["board_revision"] == 5

    revision = {"board_revision": 5, "event_revision": 3}
    assert _client(db, other).post(f"{root}/{event_id}/archive", json=revision).status_code == 403
    archived = editor_client.post(f"{root}/{event_id}/archive", json=revision)
    assert archived.status_code == 200 and archived.json()["event_revision"] == 4
    assert manager_client.get(f"{root}?archived=archived").json()["pagination"]["total"] == 1
    no_edit = editor_client.patch(
        f"{root}/{event_id}", json={"board_revision": 6, "event_revision": 4, "title": "No"}
    )
    assert no_edit.json()["detail"]["code"] == "event_archived"
    restored = editor_client.post(
        f"{root}/{event_id}/restore", json={"board_revision": 6, "event_revision": 4}
    )
    assert restored.status_code == 200 and restored.json()["board_revision"] == 7
    live_delete = manager_client.request(
        "DELETE", f"{root}/{event_id}", json={"board_revision": 7, "event_revision": 5}
    )
    assert live_delete.status_code == 405
    assert (
        manager_client.post(
            f"{root}/{event_id}/archive", json={"board_revision": 7, "event_revision": 5}
        ).status_code
        == 200
    )
    assert (
        manager_client.request(
            "DELETE", f"{root}/{event_id}", json={"board_revision": 8, "event_revision": 6}
        ).status_code
        == 405
    )
    purger = admin(db)
    db.commit()
    monkeypatch.setattr(
        "app.systems.boards.event_purge_router.get_settings",
        lambda: type("Settings", (), {"lifecycle_purge_enabled": True})(),
    )
    monkeypatch.setattr(
        "app.systems.sandbox.lifecycle.password.ProviderPasswordGrantClient.verify_password",
        lambda *args: purger.id,
    )
    purge_api = _client(db, purger)
    preview = purge_api.post(f"{root}/{event_id}/purge/preview")
    assert preview.status_code == 200, preview.text
    deleted = purge_api.post(
        f"{root}/{event_id}/purge",
        json={
            "token": preview.json()["token"],
            "confirmation_name": "Managed",
            "password": "synthetic-step-up",
        },
    )
    assert deleted.status_code == 200, deleted.text
    assert manager_client.get(f"{root}/{event_id}").status_code == 404

    mine_create = editor_client.post(root, json=_payload(9))
    assert mine_create.status_code == 201
    mine = editor_client.get(f"{root}/mine?limit=1&offset=0")
    assert mine.status_code == 200
    assert [item["id"] for item in mine.json()["items"]] == [mine_create.json()["id"]]
    assert _client(db, reader).get(f"{root}/mine").status_code == 403
    assert mine_create.json()["id"] not in [
        item["id"] for item in _client(db, other).get(f"{root}/mine").json()["items"]
    ]
    board.status = "archived"
    db.commit()
    assert editor_client.post(root, json=_payload(10)).json()["detail"]["code"] == (
        "board_archived"
    )


@pytest.mark.integration
def test_event_capacity_applies_to_create_and_restore_without_partial_changes(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author, manager, other, reader = member(db), member(db), member(db), member(db)
    board = project_board(db)
    grant(db, board, [author, other], AccessLevel.WRITE)
    grant(db, board, [manager], AccessLevel.MANAGE)
    grant(db, board, [reader], AccessLevel.READ)
    for index in range(499):
        _series(db, board, author, f"Calendar event {index}")
    _series(db, board, author, "Retained archive").archived = True
    deleted = _series(db, board, author, "Deleted event")
    deleted.is_deleted = True
    deleted.deleted_at = datetime(2026, 9, 1, tzinfo=UTC)
    _series(db, project_board(db), author, "Another Board's event")
    db.commit()
    api = _client(db, author)
    root = f"/api/boards/{board.id}/events"
    created = api.post(root, json=_payload(1, reminders=["start"]))
    assert created.status_code == 201
    event_id = created.json()["id"]
    detail_url = f"{root}/{event_id}"
    reminder = db.scalars(
        select(BoardEventReminder).where(BoardEventReminder.event_id == UUID(event_id))
    ).one()
    reminder_id = reminder.id
    instant = datetime(2026, 9, 14, tzinfo=UTC)
    work = ScheduledWork(
        org_id=board.org_id, kind=WorkKind.EVENT_REMINDER, reminder_id=reminder_id,
        occurrence_start_at=instant, scheduled_for=instant, next_attempt_at=instant,
        state=WorkState.SUCCEEDED, finished_at=instant,
    )
    db.add(work)
    db.commit()
    work_id = work.id

    archived = api.post(
        f"{detail_url}/archive", json={"board_revision": 2, "event_revision": 1}
    )
    assert archived.status_code == 200
    replacement = api.post(root, json=_payload(3, title="Replacement event"))
    assert replacement.status_code == 201
    replacement_url = f"{root}/{replacement.json()['id']}"
    before = api.get(detail_url).json()
    assert before["archived"] is True
    assert (before["revision"], before["board_revision"]) == (2, 4)
    revision = {"board_revision": 4, "event_revision": 2}
    assert _client(db, reader).post(f"{detail_url}/restore", json=revision).status_code == 403
    assert _client(db, other).post(f"{detail_url}/restore", json=revision).status_code == 403
    for stale, code in (
        ({"board_revision": 3, "event_revision": 2}, "stale_board_revision"),
        ({"board_revision": 4, "event_revision": 1}, "stale_event_revision"),
    ):
        refused = api.post(f"{detail_url}/restore", json=stale)
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == code
    already_active = api.post(
        f"{replacement_url}/restore", json={"board_revision": 4, "event_revision": 1}
    )
    assert already_active.status_code == 409
    assert already_active.json()["detail"]["code"] == "event_not_archived"

    capacity_error = {
        "detail": {"code": "event_limit_reached", "message": "The Board has 500 active events"}
    }
    refused_create = api.post(root, json=_payload(4, reminders=["15m"]))
    assert refused_create.status_code == 409
    assert refused_create.json() == capacity_error
    refused_restore = api.post(f"{detail_url}/restore", json=revision)
    assert refused_restore.status_code == 409
    assert refused_restore.json() == capacity_error
    db.expire_all()
    assert api.get(detail_url).json() == before
    assert api.get(root).json()["pagination"]["total"] == 500
    assert list(db.execute(
        select(BoardEventReminder.id, BoardEventReminder.timing).where(
            BoardEventReminder.board_id == board.id
        )
    )) == [(reminder_id, "start")]
    assert list(db.execute(
        select(ScheduledWork.id, ScheduledWork.state, ScheduledWork.finished_at).where(
            ScheduledWork.reminder_id == reminder_id
        )
    )) == [(work_id, WorkState.SUCCEEDED, instant)]

    freed = api.post(
        f"{replacement_url}/archive", json={"board_revision": 4, "event_revision": 1}
    )
    assert freed.status_code == 200
    restored = _client(db, manager).post(
        f"{detail_url}/restore", json={"board_revision": 5, "event_revision": 2}
    )
    assert restored.status_code == 200
    assert restored.json() == {"id": event_id, "event_revision": 3, "board_revision": 6}
    current = api.get(detail_url).json()
    assert current["archived"] is False
    assert current["reminders"] == ["start"]
    calendar = api.get(
        f"{root}/occurrences", params={"window_start": "2026-09-01", "window_end": "2026-09-30"}
    )
    assert calendar.status_code == 200
    assert calendar.json()["pagination"]["total"] == 500
    assert calendar.json()["board_revision"] == 6


@pytest.mark.integration
def test_every_reader_sees_every_event_and_outsiders_see_none(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author, reader, outsider = member(db), member(db), member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    grant(db, board, [reader], AccessLevel.READ)
    first, second = _series(db, board, author, "One"), _series(db, board, author, "Two")
    db.commit()
    root = f"/api/boards/{board.id}/events"

    listed = _client(db, reader).get(root).json()
    assert {item["id"] for item in listed["items"]} == {str(first.id), str(second.id)}
    assert all(item["reminders"] == [] for item in listed["items"])
    occurrences = _client(db, reader).get(
        f"{root}/occurrences?window_start=2026-09-01&window_end=2026-09-30"
    )
    assert occurrences.status_code == 200
    assert occurrences.json()["pagination"]["total"] == 2
    assert _client(db, outsider).get(root).status_code == 404
