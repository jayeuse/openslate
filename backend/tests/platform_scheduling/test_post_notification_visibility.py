"""Published Post notices are paged only under current recipient policy."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)
from app.systems.platform.scheduling.service import current_user_notification_query
from tests.boards.support import department_board
from tests.conftest import create_member
from tests.platform_scheduling.support import assert_notice_hidden, notification_client
from tests.rbac.support import add_department, make_group_access, organization

pytestmark = pytest.mark.integration
NOW = datetime(2026, 9, 24, 12, tzinfo=UTC)


def _actor(db: Session, label: str) -> User:
    role = "member"
    actor, _membership = create_member(
        db, organization(db),
        email=f"post-notice-{uuid7().hex}@example.test",
        username=f"post_notice_{uuid7().hex[:12]}",
        status="active",
        role=role,
    )
    return actor


def test_post_notice_list_and_read_hide_after_department_revocation_or_board_archive(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "owner")
    viewer = _actor(db, "viewer")
    department = add_department(db)
    access = make_group_access(db, [viewer], department, level=AccessLevel.READ)
    board = department_board(db, department)
    post = BoardPost(
        org_id=board.org_id,
        board_id=board.id,
        author_id=owner.id,
        title="Private published heading",
        body="Private published body",
        status="published",
        displayed_publication_number=1,
    )
    db.add(post)
    db.flush()
    revision = BoardPostRevision(
        org_id=board.org_id,
        post_id=post.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint="a" * 64,
        author_id=owner.id,
        title=post.title,
        body=post.body,
        published_at=NOW,
    )
    db.add(revision)
    db.flush()
    work = ScheduledWork(
        org_id=board.org_id,
        kind=WorkKind.POST_PUBLISH,
        post_id=post.id,
        source_revision=1,
        scheduling_actor_id=owner.id,
        publication_result_id=revision.id,
        scheduled_for=NOW,
        next_attempt_at=NOW,
        state=WorkState.SUCCEEDED,
    )
    db.add(work)
    db.flush()
    notice = InAppNotification(
        org_id=board.org_id,
        work_id=work.id,
        recipient_id=viewer.id,
        kind="post-publish",
        subject_type="board_post",
        subject_id=post.id,
    )
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

    client = notification_client(db, viewer)
    visible = client.get("/api/notifications")
    assert visible.status_code == 200, visible.text
    assert visible.json()["pagination"]["total"] == 1
    assert client.get("/api/notifications/unread-count").json() == {"unread_count": 1}
    assert visible.json()["items"][0]["kind"] == "post-publish"
    assert visible.json()["items"][0]["board_id"] == str(board.id)
    assert visible.json()["items"][0]["post_id"] == str(post.id)
    assert visible.json()["items"][0]["publication_revision_id"] == str(revision.id)
    assert "Private published" not in visible.text
    path = f"/api/notifications/{notice.id}/read"

    db.delete(access)
    db.commit()
    db.expire_all()
    assert_notice_hidden(client, notice.id)
    assert db.get(InAppNotification, notice.id).read_at is None

    make_group_access(db, [viewer], department, level=AccessLevel.READ)
    db.commit()
    db.expire_all()
    assert client.get("/api/notifications").json()["pagination"]["total"] == 1
    board.status = "archived"
    db.commit()
    db.expire_all()
    assert_notice_hidden(client, notice.id)
    assert db.get(InAppNotification, notice.id).read_at is None

    board.status = "active"
    db.commit()
    db.expire_all()
    assert client.post(path).status_code == 200
    assert client.get("/api/notifications/unread-count").json() == {"unread_count": 0}
