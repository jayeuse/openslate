"""Board event API: input contract, author and manager lifecycle, and revisions."""

from datetime import date

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.event_author_router import router as author_router
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import router
from app.systems.boards.event_schemas import EventCreate
from app.systems.boards.models import Board
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
