"""Board purge includes retained announcement work and notifications in its challenge."""

from datetime import UTC, datetime
from secrets import token_urlsafe

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.main import app as application
from app.systems.access.users.models import Role, User
from app.systems.boards import lifecycle_router
from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.manage.audit.context import set_audit_actor
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)
from tests.boards.provider_accounts import create_password_account

pytestmark = pytest.mark.integration


def test_board_purge_route_is_mounted_after_reminder_children_join_inventory() -> None:
    assert "/api/boards/{board_id}/purge/preview" in application.openapi()["paths"]


def test_board_purge_challenges_and_deletes_content_work_dependencies(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    password = token_urlsafe(32)
    role = db.scalar(select(Role).where(Role.role == "admin"))
    assert role is not None
    actor_id = uuid7()
    email = f"board-work-purge-{actor_id.hex}@example.test"
    provider_user_id = create_password_account(db, email=email, password=password)
    actor = User(
        id=actor_id,
        email=email,
        supabase_user_id=provider_user_id,
        username=f"board_work_purge_{actor_id.hex[:12]}",
        status="active",
        role_id=role.id,
        role=role,
    )
    db.add(actor)
    db.flush()
    set_audit_actor(db, actor.id)
    board = Board(owner_id=actor.id, name="Purge work board", status="archived")
    db.add(board)
    db.flush()
    announcement = BoardAnnouncement(
        board_id=board.id,
        author_id=actor.id,
        title="Private draft title",
        body="Private draft body",
        status="archived",
        audience_kind="everyone",
    )
    db.add(announcement)
    db.flush()
    now = datetime.now(UTC)
    revision = BoardAnnouncementRevision(
        announcement_id=announcement.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint="a" * 64,
        author_id=actor.id,
        title="Private published title",
        body="Private published body",
        audience_kind="everyone",
        published_at=now,
    )
    db.add(revision)
    db.flush()
    work = ScheduledWork(
        kind=WorkKind.ANNOUNCEMENT_PUBLISH,
        announcement_id=announcement.id,
        source_revision=1,
        scheduling_actor_id=actor.id,
        publication_result_id=revision.id,
        scheduled_for=now,
        next_attempt_at=now,
        state=WorkState.SUCCEEDED,
    )
    db.add(work)
    db.flush()
    notification = InAppNotification(work_id=work.id, recipient_id=actor.id)
    db.add(notification)
    event = BoardEvent(
        board_id=board.id,
        author_id=actor.id,
        title="Reminder Event",
        all_day=True,
        start_date=now.date(),
        end_date=now.date(),
        timezone_name="UTC",
        audience_kind="everyone",
    )
    db.add(event)
    db.flush()
    reminder = BoardEventReminder(
        board_id=board.id,
        event_id=event.id,
        recipient_id=actor.id,
        occurrence_id=f"{event.id}:{now.date().isoformat()}",
        occurrence_start_at=now,
        timing="now",
        due_at=now,
    )
    db.add(reminder)
    db.flush()
    reminder_work = ScheduledWork(
        kind=WorkKind.EVENT_REMINDER,
        reminder_id=reminder.id,
        scheduled_for=now,
        next_attempt_at=now,
        state=WorkState.SUCCEEDED,
    )
    db.add(reminder_work)
    db.flush()
    reminder_notification = InAppNotification(work_id=reminder_work.id, recipient_id=actor.id)
    db.add(reminder_notification)
    db.commit()

    monkeypatch.setattr(
        lifecycle_router,
        "get_settings",
        lambda: type("Settings", (), {"lifecycle_purge_enabled": True})(),
    )
    app = FastAPI()
    app.include_router(lifecycle_router.router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    client = TestClient(app)
    path = f"/api/boards/{board.id}/purge"
    preview = client.post(f"{path}/preview")
    assert preview.status_code == 200, preview.text
    assert {(row["entity_type"], row["entity_id"]) for row in preview.json()["impact"]["rows"]} == {
        ("boards", str(board.id)),
        ("board_announcements", str(announcement.id)),
        ("board_announcement_revisions", str(revision.id)),
        ("scheduled_work", str(work.id)),
        ("in_app_notifications", str(notification.id)),
        ("board_events", str(event.id)),
        ("board_event_reminders", str(reminder.id)),
        ("scheduled_work", str(reminder_work.id)),
        ("in_app_notifications", str(reminder_notification.id)),
    }
    assert "Private" not in preview.text
    notification.read_at = now
    db.commit()
    stale = client.post(
        path,
        json={
            "token": preview.json()["token"],
            "confirmation_name": str(board.id),
            "password": password,
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "impact_changed"
    assert db.get(Board, board.id) is not None
    assert db.get(ScheduledWork, work.id) is not None

    current = client.post(f"{path}/preview")
    assert current.status_code == 200
    deleted = client.post(
        path,
        json={
            "token": current.json()["token"],
            "confirmation_name": str(board.id),
            "password": password,
        },
    )
    assert deleted.status_code == 200, deleted.text
    for model, row_id in (
        (InAppNotification, notification.id),
        (ScheduledWork, work.id),
        (BoardAnnouncementRevision, revision.id),
        (BoardAnnouncement, announcement.id),
        (InAppNotification, reminder_notification.id),
        (ScheduledWork, reminder_work.id),
        (BoardEventReminder, reminder.id),
        (BoardEvent, event.id),
        (Board, board.id),
    ):
        assert db.get(model, row_id) is None
