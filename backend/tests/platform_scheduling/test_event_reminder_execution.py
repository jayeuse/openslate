"""Due Event reminders deliver once only under current recipient/content policy."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.systems.access.users.models import User
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardGrant
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork, WorkState
from app.systems.platform.scheduling.notification_router import router as notification_router
from app.systems.platform.scheduling.reminder_execution import (
    claim_due_reminder_work,
    execute_due_reminders,
    fail_reminder_work,
    finalize_reminder_claim,
)

pytestmark = pytest.mark.integration
pytest_plugins = ("tests.reports.test_report_run_routes",)
NOW = datetime(2026, 9, 24, 12, tzinfo=UTC)


def _user(db: Session, label: str) -> User:
    role = "member"
    actor = User(
        email=f"reminder-work-{uuid7().hex}@example.test",
        username=f"reminder_work_{uuid7().hex[:12]}",
        status="active",
        role=role,
    )
    db.add(actor)
    db.flush()
    return actor


def _subject(
    db: Session,
) -> tuple[User, User, Board, BoardEvent, BoardEventReminder, ScheduledWork]:
    owner = _user(db, "owner")
    recipient = _user(db, "recipient")
    board = Board(owner_id=owner.id, name=f"Due reminder {uuid7().hex[:10]}", status="active")
    db.add(board)
    db.flush()
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="user",
            principal_user_id=recipient.id,
            permission="view",
            effect="allow",
        )
    )
    start = datetime(2026, 10, 1, 9, tzinfo=UTC)
    event = BoardEvent(
        board_id=board.id,
        author_id=owner.id,
        title="Private dispatch",
        all_day=False,
        start_at=start,
        end_at=start + timedelta(hours=1),
        timezone_name="UTC",
        audience_kind="everyone",
    )
    db.add(event)
    db.flush()
    reminder = BoardEventReminder(
        board_id=board.id,
        event_id=event.id,
        recipient_id=recipient.id,
        occurrence_id=f"{event.id}:2026-10-01T09:00:00Z",
        occurrence_start_at=start,
        timing="now",
        due_at=NOW,
    )
    db.add(reminder)
    db.flush()
    work = ScheduledWork(
        kind="event-reminder", reminder_id=reminder.id, scheduled_for=NOW, next_attempt_at=NOW
    )
    db.add(work)
    db.flush()
    return owner, recipient, board, event, reminder, work


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(notification_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def test_due_reminder_claim_delivers_one_reference_and_replay_cannot_duplicate(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    _, recipient, _, _, _, work = _subject(db)
    db.commit()
    claims = claim_due_reminder_work(db, now=NOW)
    assert [claim.id for claim in claims] == [work.id]
    db.commit()

    notice_id = finalize_reminder_claim(db, claims[0], now=NOW)
    db.commit()
    assert notice_id is not None
    notice = db.get(InAppNotification, notice_id)
    assert notice is not None and notice.recipient_id == recipient.id
    assert notice.work_id == work.id
    assert db.get(ScheduledWork, work.id).state == WorkState.SUCCEEDED
    assert finalize_reminder_claim(db, claims[0], now=NOW) is None
    assert claim_due_reminder_work(db, now=NOW) == []
    assert (
        db.scalar(select(InAppNotification).where(InAppNotification.work_id == work.id)) == notice
    )


def test_runtime_role_worker_commits_one_reminder_notice(report_run_fixture) -> None:
    subject = report_run_fixture
    start = datetime(2026, 10, 1, 9, tzinfo=UTC)
    with AuditSession(subject.owner_engine) as db:
        db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
        board = Board(owner_id=subject.owner_id, name=f"Runtime reminder {uuid7().hex[:12]}")
        db.add(board)
        db.flush()
        event = BoardEvent(
            board_id=board.id,
            author_id=subject.owner_id,
            title="Runtime delivery",
            all_day=False,
            start_at=start,
            end_at=start + timedelta(hours=1),
            timezone_name="UTC",
            audience_kind="everyone",
        )
        db.add(event)
        db.flush()
        reminder = BoardEventReminder(
            board_id=board.id,
            event_id=event.id,
            recipient_id=subject.owner_id,
            occurrence_id=f"{event.id}:2026-10-01T09:00:00Z",
            occurrence_start_at=start,
            timing="now",
            due_at=NOW,
        )
        db.add(reminder)
        db.flush()
        work = ScheduledWork(
            kind="event-reminder", reminder_id=reminder.id, scheduled_for=NOW, next_attempt_at=NOW
        )
        db.add(work)
        db.commit()
        board_id, event_id, reminder_id, work_id = board.id, event.id, reminder.id, work.id
    try:
        delivered = execute_due_reminders(subject.runtime_engine, now=NOW)
        assert len(delivered) == 1
        assert execute_due_reminders(subject.runtime_engine, now=NOW) == []
        with AuditSession(subject.owner_engine) as db:
            notice = db.get(InAppNotification, delivered[0])
            assert notice is not None
            assert notice.recipient_id == subject.owner_id and notice.work_id == work_id
            assert db.get(ScheduledWork, work_id).state == WorkState.SUCCEEDED
    finally:
        with AuditSession(subject.owner_engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            for notice in db.scalars(
                select(InAppNotification).where(InAppNotification.work_id == work_id)
            ):
                db.delete(notice)
            db.flush()
            db.delete(db.get(ScheduledWork, work_id))
            db.flush()
            db.delete(db.get(BoardEventReminder, reminder_id))
            db.flush()
            db.delete(db.get(BoardEvent, event_id))
            db.flush()
            db.delete(db.get(Board, board_id))
            db.commit()


def test_audience_revocation_before_delivery_cancels_without_a_notice(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    _, _, _, event, _, work = _subject(db)
    db.commit()
    claim = claim_due_reminder_work(db, now=NOW)[0]
    db.commit()
    event.audience_kind = "author"
    db.commit()

    assert finalize_reminder_claim(db, claim, now=NOW) is None
    db.commit()
    assert db.get(ScheduledWork, work.id).state == WorkState.CANCELED
    assert db.scalar(select(InAppNotification).where(InAppNotification.work_id == work.id)) is None


def test_board_view_revocation_before_delivery_cancels_without_a_notice(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    _, recipient, board, _, _, work = _subject(db)
    db.commit()
    claim = claim_due_reminder_work(db, now=NOW)[0]
    db.commit()
    grant = db.scalar(
        select(BoardGrant).where(
            BoardGrant.board_id == board.id,
            BoardGrant.principal_user_id == recipient.id,
        )
    )
    assert grant is not None
    grant.effect = "deny"
    db.commit()

    assert finalize_reminder_claim(db, claim, now=NOW) is None
    db.commit()
    assert db.get(ScheduledWork, work.id).state == WorkState.CANCELED
    assert db.scalar(select(InAppNotification).where(InAppNotification.work_id == work.id)) is None


def test_disabled_recipient_before_delivery_cancels_without_a_notice(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    _, recipient, _, _, _, work = _subject(db)
    db.commit()
    claim = claim_due_reminder_work(db, now=NOW)[0]
    db.commit()
    recipient.status = "disabled"
    db.commit()

    assert finalize_reminder_claim(db, claim, now=NOW) is None
    db.commit()
    assert db.get(ScheduledWork, work.id).state == WorkState.CANCELED
    assert db.scalar(select(InAppNotification).where(InAppNotification.work_id == work.id)) is None


def test_failed_reminder_claim_retries_with_backoff_and_rejects_stale_lease(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    _subject(db)
    db.commit()
    first = claim_due_reminder_work(db, now=NOW)[0]
    db.commit()
    assert fail_reminder_work(db, first, now=NOW)
    db.commit()
    assert claim_due_reminder_work(db, now=NOW) == []
    second = claim_due_reminder_work(db, now=NOW + timedelta(seconds=2))[0]
    db.commit()
    assert finalize_reminder_claim(db, first, now=NOW + timedelta(seconds=2)) is None
    assert finalize_reminder_claim(db, second, now=NOW + timedelta(seconds=2)) is not None


def test_reminder_inbox_read_rechecks_current_audience_and_active_recipient(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    _, recipient, board, event, _, work = _subject(db)
    db.commit()
    claim = claim_due_reminder_work(db, now=NOW)[0]
    db.commit()
    notice_id = finalize_reminder_claim(db, claim, now=NOW)
    assert notice_id is not None
    db.commit()

    client = _client(db, recipient)
    inbox = client.get("/api/notifications")
    assert inbox.status_code == 200, inbox.text
    assert inbox.json()["pagination"]["total"] == 1
    item = inbox.json()["items"][0]
    assert item["kind"] == "event-reminder"
    assert item["event_id"] == str(event.id)
    assert item["id"] == str(notice_id)
    assert "title" not in item
    marked = client.post(f"/api/notifications/{notice_id}/read")
    assert marked.status_code == 200
    assert marked.json()["status"] == "read"

    event.audience_kind = "author"
    db.commit()
    assert client.get("/api/notifications").json()["pagination"]["total"] == 0
    assert client.post(f"/api/notifications/{notice_id}/read").status_code == 404
    event.audience_kind = "everyone"
    grant = db.scalar(
        select(BoardGrant).where(
            BoardGrant.board_id == board.id,
            BoardGrant.principal_user_id == recipient.id,
        )
    )
    assert grant is not None
    grant.effect = "deny"
    db.commit()
    assert client.get("/api/notifications").json()["pagination"]["total"] == 0
    grant.effect = "allow"
    recipient.status = "disabled"
    db.commit()
    assert client.get("/api/notifications").json()["pagination"]["total"] == 0
    assert db.get(ScheduledWork, work.id).state == WorkState.SUCCEEDED
