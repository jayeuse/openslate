"""Published Announcement notices are paged only under current recipient policy."""

from datetime import UTC, datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.models import Board, BoardGrant
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)
from app.systems.platform.scheduling.notification_router import router as notification_router
from app.systems.platform.scheduling.service import current_user_notification_query
from tests.rbac.support import add_department, make_group_access

pytestmark = pytest.mark.integration
NOW = datetime(2026, 9, 24, 12, tzinfo=UTC)


def _actor(db: Session, label: str) -> User:
    role = "member"
    actor = User(
        email=f"announcement-notice-{uuid7().hex}@example.test",
        username=f"announcement_notice_{uuid7().hex[:12]}",
        status="active",
        role=role,
    )
    db.add(actor)
    db.flush()
    return actor


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(notification_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def test_announcement_notice_list_and_read_hide_after_department_or_board_revocation(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "owner")
    viewer = _actor(db, "viewer")
    department = add_department(db)
    access = make_group_access(db, [viewer], department, level=AccessLevel.READ)
    board = Board(owner_id=owner.id, name=f"Announcement inbox {uuid7().hex[:12]}")
    db.add(board)
    db.flush()
    grant = BoardGrant(
        board_id=board.id,
        principal_type="user",
        principal_user_id=viewer.id,
        permission="view",
        effect="allow",
    )
    announcement = BoardAnnouncement(
        board_id=board.id,
        author_id=owner.id,
        title="Private published heading",
        body="Private published body",
        status="published",
        displayed_publication_number=1,
        audience_kind="department",
        audience_department_id=department.id,
    )
    db.add_all((grant, announcement))
    db.flush()
    revision = BoardAnnouncementRevision(
        announcement_id=announcement.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint="a" * 64,
        author_id=owner.id,
        title=announcement.title,
        body=announcement.body,
        audience_kind="department",
        audience_department_id=department.id,
        published_at=NOW,
    )
    db.add(revision)
    db.flush()
    work = ScheduledWork(
        kind=WorkKind.ANNOUNCEMENT_PUBLISH,
        announcement_id=announcement.id,
        source_revision=1,
        scheduling_actor_id=owner.id,
        publication_result_id=revision.id,
        scheduled_for=NOW,
        next_attempt_at=NOW,
        state=WorkState.SUCCEEDED,
    )
    db.add(work)
    db.flush()
    notice = InAppNotification(work_id=work.id, recipient_id=viewer.id)
    db.add(notice)
    db.commit()

    observed_sql: list[str] = []
    connection = db.get_bind()

    def observe(_connection, _cursor, statement, _parameters, _context, _many) -> None:
        observed_sql.append(statement)

    event.listen(connection, "before_cursor_execute", observe)
    try:
        current_user_notification_query(db, viewer.id)
    finally:
        event.remove(connection, "before_cursor_execute", observe)
    assert all("in_app_notifications" not in sql for sql in observed_sql)

    client = _client(db, viewer)
    visible = client.get("/api/notifications")
    assert visible.status_code == 200, visible.text
    assert visible.json()["pagination"]["total"] == 1
    assert visible.json()["items"][0]["kind"] == "announcement-publish"
    assert visible.json()["items"][0]["board_id"] == str(board.id)
    assert visible.json()["items"][0]["announcement_id"] == str(announcement.id)
    assert visible.json()["items"][0]["publication_revision_id"] == str(revision.id)
    assert "Private published" not in visible.text
    path = f"/api/notifications/{notice.id}/read"
    assert client.post(path).status_code == 200

    db.delete(access)
    db.commit()
    db.expire_all()
    assert client.get("/api/notifications").json()["pagination"]["total"] == 0
    assert client.post(path).status_code == 404

    make_group_access(db, [viewer], department, level=AccessLevel.READ)
    grant.effect = "deny"
    db.commit()
    db.expire_all()
    assert client.get("/api/notifications").json()["pagination"]["total"] == 0
    assert client.post(path).status_code == 404
