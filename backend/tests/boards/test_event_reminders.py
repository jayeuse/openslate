"""Persisted personal Event reminders and Event mutation reconciliation."""

from datetime import UTC, date, datetime, timedelta
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.core.security.tokens import TokenType, decode_token
from app.main import create_app
from app.systems.access.users.models import Role, User
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import router as event_router
from app.systems.boards.models import Board, BoardGrant
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.boards.reminder_router import router as reminder_router
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)
from app.systems.platform.scheduling.reminder_execution import execute_due_reminders

pytest_plugins = ("tests.reports.test_report_run_routes",)


def _owner(db: Session) -> User:
    role = Role(
        role=f"reminder-{uuid7().hex[:12]}",
        permissions={"records.read": True, "records.write": True},
    )
    db.add(role)
    db.flush()
    actor_id = uuid7()
    actor = User(
        id=actor_id,
        email=f"reminder-{actor_id.hex}@example.test",
        username=f"reminder_{actor_id.hex[:12]}",
        status="active",
        role_id=role.id,
        role=role,
    )
    db.add(actor)
    db.flush()
    return actor


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(event_router, prefix="/api")
    app.include_router(reminder_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _october_pending_reminders(
    db: Session, event: BoardEvent, recipient_id: UUID, days: tuple[int, ...]
) -> tuple[list[BoardEventReminder], list[ScheduledWork]]:
    reminders = []
    works = []
    for reminder_id, day in zip(sorted(uuid7() for _ in days), days, strict=True):
        start = datetime(2026, 10, day, tzinfo=UTC)
        due = start - timedelta(minutes=15)
        reminder = BoardEventReminder(
            id=reminder_id,
            board_id=event.board_id,
            event_id=event.id,
            recipient_id=recipient_id,
            occurrence_id=f"{event.id}:2026-10-{day:02d}",
            occurrence_start_at=start,
            timing="15m",
            due_at=due,
        )
        db.add(reminder)
        db.flush()
        work = ScheduledWork(
            kind=WorkKind.EVENT_REMINDER,
            reminder_id=reminder.id,
            scheduled_for=due,
            next_attempt_at=due,
        )
        db.add(work)
        reminders.append(reminder)
        works.append(work)
    return reminders, works


@pytest.mark.integration
def test_event_edit_moves_one_pending_reminder_with_single_timed_occurrence(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    actor = _owner(db)
    board = Board(owner_id=actor.id, name=f"Reminder {uuid7().hex[:12]}", status="active")
    db.add(board)
    db.flush()
    start = datetime(2026, 10, 1, 9, tzinfo=UTC)
    event = BoardEvent(
        board_id=board.id,
        author_id=actor.id,
        title="Shifted appointment",
        all_day=False,
        start_at=start,
        end_at=start + timedelta(hours=1),
        timezone_name="UTC",
        audience_kind="everyone",
    )
    db.add(event)
    db.flush()
    due = start - timedelta(minutes=15)
    reminder = BoardEventReminder(
        board_id=board.id,
        event_id=event.id,
        recipient_id=actor.id,
        occurrence_id=f"{event.id}:2026-10-01T09:00:00Z",
        occurrence_start_at=start,
        timing="15m",
        due_at=due,
    )
    db.add(reminder)
    db.flush()
    work = ScheduledWork(
        kind=WorkKind.EVENT_REMINDER,
        reminder_id=reminder.id,
        scheduled_for=due,
        next_attempt_at=due,
    )
    db.add(work)
    db.commit()

    changed_start = datetime(2026, 10, 2, 11, tzinfo=UTC)
    response = _client(db, actor).patch(
        f"/api/boards/{board.id}/events/{event.id}",
        json={
            "board_revision": 1,
            "event_revision": 1,
            "start_at": "2026-10-02T11:00:00Z",
            "end_at": "2026-10-02T12:00:00Z",
        },
    )
    assert response.status_code == 200, response.text
    db.expire_all()
    saved = db.get(BoardEventReminder, reminder.id)
    queued = db.scalar(select(ScheduledWork).where(ScheduledWork.id == work.id))
    assert saved is not None and queued is not None
    assert saved.occurrence_id == f"{event.id}:2026-10-02T11:00:00Z"
    assert saved.occurrence_start_at == changed_start
    assert saved.due_at == changed_start - timedelta(minutes=15)
    assert queued.scheduled_for == saved.due_at
    assert queued.next_attempt_at == saved.due_at
    assert queued.state == WorkState.PENDING


@pytest.mark.integration
def test_personal_reminder_create_list_cancel_and_manager_audience_denial(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _owner(db)
    manager = _owner(db)
    board = Board(owner_id=owner.id, name=f"Private reminder {uuid7().hex[:12]}", status="active")
    db.add(board)
    db.flush()
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="user",
            principal_user_id=manager.id,
            permission="manage",
            effect="allow",
        )
    )
    day = datetime(2026, 11, 1, tzinfo=UTC).date()
    event = BoardEvent(
        board_id=board.id,
        author_id=owner.id,
        title="Private calendar item",
        all_day=True,
        start_date=day,
        end_date=day,
        timezone_name="America/New_York",
        audience_kind="author",
    )
    db.add(event)
    db.commit()
    route = f"/api/boards/{board.id}/events/{event.id}/reminders"
    payload = {"occurrence_id": f"{event.id}:2026-11-01", "timing": "15m"}

    hidden = _client(db, manager).post(route, json=payload)
    assert hidden.status_code == 404
    manager_list = _client(db, manager).get(f"/api/boards/{board.id}/reminders")
    assert manager_list.status_code == 200
    assert manager_list.json()["pagination"]["total"] == 0

    created = _client(db, owner).post(route, json=payload)
    assert created.status_code == 201, created.text
    assert created.json()["due_at"] == "2026-11-01T03:45:00Z"
    assert created.json()["state"] == "pending"
    own_list = _client(db, owner).get(f"/api/boards/{board.id}/reminders")
    assert own_list.status_code == 200
    assert own_list.json()["pagination"]["total"] == 1
    assert [item["id"] for item in own_list.json()["items"]] == [created.json()["id"]]

    canceled = _client(db, owner).delete(f"/api/boards/{board.id}/reminders/{created.json()['id']}")
    assert canceled.status_code == 204
    assert (
        _client(db, owner)
        .delete(f"/api/boards/{board.id}/reminders/{created.json()['id']}")
        .status_code
        == 204
    )
    assert (
        _client(db, owner).get(f"/api/boards/{board.id}/reminders").json()["pagination"]["total"]
        == 0
    )

    work = db.scalar(
        select(ScheduledWork).where(ScheduledWork.reminder_id == created.json()["id"])
    )
    assert work is not None
    work.state = WorkState.RUNNING
    work.lease_token = uuid7()
    work.lease_expires_at = datetime.now(UTC) + timedelta(minutes=1)
    db.commit()
    running = _client(db, owner).delete(
        f"/api/boards/{board.id}/reminders/{created.json()['id']}"
    )
    assert running.status_code == 409
    assert running.json()["detail"]["code"] == "reminder_not_cancelable"
    db.refresh(work)
    assert work.state == WorkState.RUNNING

    work.state = WorkState.SUCCEEDED
    work.lease_token = None
    work.lease_expires_at = None
    db.commit()
    completed = _client(db, owner).delete(
        f"/api/boards/{board.id}/reminders/{created.json()['id']}"
    )
    assert completed.status_code == 409
    assert completed.json()["detail"]["code"] == "reminder_not_cancelable"
    db.refresh(work)
    assert work.state == WorkState.SUCCEEDED


@pytest.mark.integration
def test_event_edit_moves_into_removed_occurrence_and_cancels_other_pending_reminder(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _owner(db)
    board = Board(owner_id=owner.id, name=f"Removed reminder {uuid7().hex[:12]}", status="active")
    db.add(board)
    db.flush()
    event = BoardEvent(
        board_id=board.id,
        author_id=owner.id,
        title="Daily check-in",
        all_day=True,
        start_date=date(2026, 10, 1),
        end_date=date(2026, 10, 1),
        timezone_name="UTC",
        recurrence="daily",
        repeat_until=date(2026, 10, 2),
        audience_kind="everyone",
    )
    db.add(event)
    db.flush()
    reminders, works = _october_pending_reminders(db, event, owner.id, (1, 2))
    db.commit()

    response = _client(db, owner).patch(
        f"/api/boards/{board.id}/events/{event.id}",
        json={
            "board_revision": 1,
            "event_revision": 1,
            "start_date": "2026-10-02",
            "end_date": "2026-10-02",
            "repeat_until": "2026-10-02",
        },
    )
    assert response.status_code == 200, response.text
    db.expire_all()
    first, removed = (db.get(BoardEventReminder, reminder.id) for reminder in reminders)
    first_work, removed_work = (db.get(ScheduledWork, work.id) for work in works)
    assert first is not None and removed is not None
    assert first_work is not None and removed_work is not None
    assert first.occurrence_id == f"{event.id}:2026-10-02"
    assert first_work.state == WorkState.PENDING
    assert removed_work.state == WorkState.CANCELED
    archived = _client(db, owner).post(
        f"/api/boards/{board.id}/events/{event.id}/archive",
        json={"board_revision": 2, "event_revision": 2},
    )
    assert archived.status_code == 200, archived.text
    deleted = _client(db, owner).request(
        "DELETE",
        f"/api/boards/{board.id}/events/{event.id}",
        json={"board_revision": 3, "event_revision": 3},
    )
    assert deleted.status_code == 204, deleted.text
    assert all(db.get(BoardEventReminder, reminder.id) is None for reminder in reminders)
    assert all(db.get(ScheduledWork, work.id) is None for work in works)


@pytest.mark.integration
def test_daily_series_shift_moves_both_adjacent_pending_reminders(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _owner(db)
    board = Board(owner_id=owner.id, name=f"Adjacent reminders {uuid7().hex[:12]}")
    db.add(board)
    db.flush()
    event = BoardEvent(
        board_id=board.id,
        author_id=owner.id,
        title="Daily handoff",
        all_day=True,
        start_date=date(2026, 10, 1),
        end_date=date(2026, 10, 1),
        timezone_name="UTC",
        recurrence="daily",
        repeat_until=date(2026, 10, 3),
        audience_kind="everyone",
    )
    db.add(event)
    db.flush()
    reminders, works = _october_pending_reminders(db, event, owner.id, (1, 2))
    db.commit()

    response = _client(db, owner).patch(
        f"/api/boards/{board.id}/events/{event.id}",
        json={
            "board_revision": 1,
            "event_revision": 1,
            "start_date": "2026-10-02",
            "end_date": "2026-10-02",
            "repeat_until": "2026-10-04",
        },
    )
    assert response.status_code == 200, response.text
    db.expire_all()
    for reminder, work, target in zip(reminders, works, (2, 3), strict=True):
        saved = db.get(BoardEventReminder, reminder.id)
        queued = db.get(ScheduledWork, work.id)
        assert saved is not None and queued is not None
        assert saved.occurrence_id == f"{event.id}:2026-10-{target:02d}"
        assert saved.due_at == datetime(2026, 10, target, tzinfo=UTC) - timedelta(minutes=15)
        assert queued.scheduled_for == saved.due_at
        assert queued.state == WorkState.PENDING

    delivered_reminder = BoardEventReminder(
        board_id=board.id,
        event_id=event.id,
        recipient_id=owner.id,
        occurrence_id=f"{event.id}:2026-10-04",
        occurrence_start_at=datetime(2026, 10, 4, tzinfo=UTC),
        timing="start",
        due_at=datetime(2026, 10, 4, tzinfo=UTC),
    )
    db.add(delivered_reminder)
    db.flush()
    delivered_work = ScheduledWork(
        kind=WorkKind.EVENT_REMINDER,
        reminder_id=delivered_reminder.id,
        scheduled_for=delivered_reminder.due_at,
        next_attempt_at=delivered_reminder.due_at,
        state=WorkState.SUCCEEDED,
    )
    db.add(delivered_work)
    db.flush()
    db.add(InAppNotification(work_id=delivered_work.id, recipient_id=owner.id))
    db.commit()
    conflict = _client(db, owner).patch(
        f"/api/boards/{board.id}/events/{event.id}",
        json={
            "board_revision": 2,
            "event_revision": 2,
            "start_date": "2026-10-03",
            "end_date": "2026-10-03",
            "repeat_until": "2026-10-05",
        },
    )
    assert conflict.status_code == 200, conflict.text
    db.expire_all()
    assert all(db.get(ScheduledWork, work.id).state == WorkState.CANCELED for work in works)
    assert db.get(ScheduledWork, delivered_work.id).state == WorkState.SUCCEEDED


@pytest.mark.integration
def test_main_app_bearer_reminder_and_inbox_recheck_audience(report_run_fixture) -> None:
    subject = report_run_fixture
    claims = decode_token(subject.outsider_token, TokenType.ACCESS)
    assert claims is not None
    outsider_id = UUID(str(claims["sub"]))
    start = datetime(2026, 10, 1, 9, tzinfo=UTC)
    with AuditSession(subject.owner_engine) as db:
        db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
        board = Board(owner_id=subject.owner_id, name=f"Bearer reminder {uuid7().hex[:12]}")
        db.add(board)
        db.flush()
        grant = BoardGrant(
            board_id=board.id,
            principal_type="user",
            principal_user_id=outsider_id,
            permission="view",
            effect="allow",
        )
        event = BoardEvent(
            board_id=board.id,
            author_id=subject.owner_id,
            title="Bearer Event",
            all_day=False,
            start_at=start,
            end_at=start + timedelta(hours=1),
            timezone_name="UTC",
            audience_kind="everyone",
        )
        db.add_all((grant, event))
        db.commit()
        board_id, event_id, grant_id = board.id, event.id, grant.id
    try:
        path = f"/api/boards/{board_id}/events/{event_id}/reminders"
        payload = {"occurrence_id": f"{event_id}:2026-10-01T09:00:00Z", "timing": "now"}
        with TestClient(create_app()) as client:
            assert client.post(path, json=payload).status_code == 401
            created = client.post(
                path,
                headers={"Authorization": f"Bearer {subject.outsider_token}"},
                json=payload,
            )
            assert created.status_code == 201, created.text
            assert (
                client.get(
                    f"/api/boards/{board_id}/reminders",
                    headers={"Authorization": f"Bearer {subject.outsider_token}"},
                ).json()["pagination"]["total"]
                == 1
            )
            due = datetime.fromisoformat(created.json()["due_at"].replace("Z", "+00:00"))
            delivered = execute_due_reminders(
                subject.runtime_engine, now=due + timedelta(seconds=1)
            )
            assert len(delivered) == 1
            inbox = client.get(
                "/api/notifications",
                headers={"Authorization": f"Bearer {subject.outsider_token}"},
            )
            assert inbox.status_code == 200, inbox.text
            assert inbox.json()["pagination"]["total"] == 1
            assert inbox.json()["items"][0]["kind"] == "event-reminder"
            read_path = f"/api/notifications/{delivered[0]}/read"
            assert (
                client.post(
                    read_path,
                    headers={"Authorization": f"Bearer {subject.outsider_token}"},
                ).status_code
                == 200
            )

            with AuditSession(subject.owner_engine) as db:
                db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
                saved_event = db.get(BoardEvent, event_id)
                assert saved_event is not None
                saved_event.audience_kind = "author"
                db.commit()
            denied = client.post(
                path,
                headers={"Authorization": f"Bearer {subject.outsider_token}"},
                json=payload,
            )
            assert denied.status_code == 404
            assert (
                client.get(
                    f"/api/boards/{board_id}/reminders",
                    headers={"Authorization": f"Bearer {subject.outsider_token}"},
                ).json()["pagination"]["total"]
                == 0
            )
            assert (
                client.get(
                    "/api/notifications",
                    headers={"Authorization": f"Bearer {subject.outsider_token}"},
                ).json()["pagination"]["total"]
                == 0
            )
            assert (
                client.post(
                    read_path,
                    headers={"Authorization": f"Bearer {subject.outsider_token}"},
                ).status_code
                == 404
            )
    finally:
        with AuditSession(subject.owner_engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            reminder = db.scalar(
                select(BoardEventReminder).where(BoardEventReminder.event_id == event_id)
            )
            if reminder is not None:
                work = db.scalar(
                    select(ScheduledWork).where(ScheduledWork.reminder_id == reminder.id)
                )
                if work is not None:
                    for notice in db.scalars(
                        select(InAppNotification).where(InAppNotification.work_id == work.id)
                    ):
                        db.delete(notice)
                    db.flush()
                    db.delete(work)
                    db.flush()
                db.delete(reminder)
                db.flush()
            for model, row_id in (
                (BoardGrant, grant_id),
                (BoardEvent, event_id),
                (Board, board_id),
            ):
                row = db.get(model, row_id)
                if row is not None:
                    db.delete(row)
                    db.flush()
            db.commit()
