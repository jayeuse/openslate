"""Current-recipient Report notification HTTP access on disposable PostgreSQL."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import event, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import GroupAccess
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditLog
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)
from tests.boards.support import board_group
from tests.platform_scheduling.support import (
    notification_actor,
    notification_client,
    notification_report,
    report_notification,
)

pytestmark = pytest.mark.integration


def test_notification_list_is_actor_scoped_bounded_and_reference_only(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = notification_actor(db)
    outsider = notification_actor(db)
    no_read = notification_actor(db, read=False)
    report, _module = notification_report(db, owner)
    first = report_notification(db, report, owner, minute=1)
    second = report_notification(db, report, owner, minute=2)
    hidden_report, hidden_module = notification_report(db, owner)
    hidden = report_notification(db, hidden_report, owner, minute=3)
    # The owner no longer reads the hidden report's module, so its notice is hidden.
    for grant in db.scalars(select(GroupAccess).where(GroupAccess.module_id == hidden_module.id)):
        grant.is_deleted = True
        grant.deleted_at = datetime.now(UTC)
    db.flush()

    response = notification_client(db, owner).get("/api/notifications?limit=1&offset=0")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["pagination"] == {
        "limit": 1,
        "offset": 0,
        "count": 1,
        "total": 2,
        "has_more": True,
    }
    assert response.json()["items"][0]["id"] == str(second.id)
    assert set(response.json()["items"][0]) == {
        "id",
        "kind",
        "subject_type",
        "subject_id",
        "report_id",
        "run_id",
        "status",
        "scheduled_for",
        "created_at",
        "read_at",
    }
    assert response.json()["items"][0]["subject_type"] == "report_run"
    assert response.json()["items"][0]["subject_id"] == response.json()["items"][0]["run_id"]
    assert response.json()["items"][0]["kind"] == "report-run"
    assert response.json()["items"][0]["status"] == "unread"
    assert "SECRET OUTPUT" not in response.text
    assert "Secret Report" not in response.text
    assert str(hidden.id) not in response.text

    page = notification_client(db, owner).get("/api/notifications?limit=1&offset=1")
    assert page.status_code == 200
    assert [item["id"] for item in page.json()["items"]] == [str(first.id)]
    assert page.json()["pagination"]["has_more"] is False
    outsider_page = notification_client(db, outsider).get("/api/notifications")
    assert outsider_page.status_code == 200
    assert outsider_page.json()["pagination"]["total"] == 0
    no_read_page = notification_client(db, no_read).get("/api/notifications")
    assert no_read_page.status_code == 200
    assert no_read_page.json()["pagination"]["total"] == 0
    assert notification_client(db, None).get("/api/notifications").status_code == 401
    for query in ("limit=0", "limit=101", "offset=-1", "sort_order=asc"):
        assert notification_client(db, owner).get(f"/api/notifications?{query}").status_code == 422


def test_mixed_notification_list_hydrates_references_with_page_bounded_queries(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = notification_actor(db)
    board = Board(scope="project", name=f"Notification hydration {uuid7().hex}")
    db.add(board)
    db.flush()
    board_group(db, board, [owner], "read")
    expected_items: list[tuple[datetime, str, dict[str, str], set[str]]] = []
    private_content: list[str] = []

    for index in range(4):
        scheduled_for = datetime(2026, 1, 1, tzinfo=UTC) + timedelta(minutes=index)
        if index % 2 == 0:
            post = BoardPost(
                board_id=board.id,
                author_id=owner.id,
                title=f"Private heading {index}",
                body=f"Private body {index}",
                status="published",
                displayed_publication_number=1,
            )
            private_content.extend((post.title, post.body))
            db.add(post)
            db.flush()
            revision = BoardPostRevision(
                post_id=post.id,
                publication_number=1,
                publication_key=uuid7(),
                content_fingerprint="a" * 64,
                author_id=owner.id,
                title=post.title,
                body=post.body,
                published_at=scheduled_for,
            )
            db.add(revision)
            db.flush()
            work = ScheduledWork(
                kind=WorkKind.POST_PUBLISH,
                post_id=post.id,
                source_revision=1,
                scheduling_actor_id=owner.id,
                publication_result_id=revision.id,
                scheduled_for=scheduled_for,
                next_attempt_at=scheduled_for,
                state=WorkState.SUCCEEDED,
            )
            reference_fields = {
                "kind": "post-publish",
                "subject_type": "board_post",
                "subject_id": str(post.id),
                "board_id": str(board.id),
                "post_id": str(post.id),
                "publication_revision_id": str(revision.id),
            }
            expected_keys = {
                "id",
                "kind",
                "subject_type",
                "subject_id",
                "board_id",
                "post_id",
                "publication_revision_id",
                "status",
                "scheduled_for",
                "created_at",
                "read_at",
            }
        else:
            event_start = scheduled_for + timedelta(days=1)
            board_event = BoardEvent(
                board_id=board.id,
                author_id=owner.id,
                title=f"Private event {index}",
                all_day=False,
                start_at=event_start,
                end_at=event_start + timedelta(hours=1),
                timezone_name="UTC",
            )
            private_content.append(board_event.title)
            db.add(board_event)
            db.flush()
            reminder = BoardEventReminder(board_id=board.id, event_id=board_event.id, timing="1d")
            db.add(reminder)
            db.flush()
            work = ScheduledWork(
                kind=WorkKind.EVENT_REMINDER,
                reminder_id=reminder.id,
                occurrence_start_at=event_start,
                scheduled_for=scheduled_for,
                next_attempt_at=scheduled_for,
                state=WorkState.SUCCEEDED,
            )
            reference_fields = {
                "kind": "event-reminder",
                "subject_type": "board_event",
                "subject_id": str(board_event.id),
                "board_id": str(board.id),
                "event_id": str(board_event.id),
                "occurrence_id": (
                    f"{board_event.id}:{event_start.isoformat().replace('+00:00', 'Z')}"
                ),
            }
            expected_keys = {
                "id",
                "kind",
                "subject_type",
                "subject_id",
                "board_id",
                "event_id",
                "occurrence_id",
                "occurrence_start_at",
                "status",
                "scheduled_for",
                "created_at",
                "read_at",
            }
        db.add(work)
        db.flush()
        notification = InAppNotification(
            work_id=work.id,
            kind=reference_fields["kind"],
            subject_type="board_post" if work.kind == WorkKind.POST_PUBLISH else "board_event",
            subject_id=UUID(
                reference_fields["post_id" if work.kind == WorkKind.POST_PUBLISH else "event_id"]
            ),
            recipient_id=owner.id,
            created_at=scheduled_for,
        )
        db.add(notification)
        db.flush()
        expected_items.append(
            (scheduled_for, str(notification.id), reference_fields, expected_keys)
        )
    db.commit()
    # Keep the detached principal usable by the route dependency while forcing
    # each request to hydrate its page references from PostgreSQL again.
    _ = owner.role
    db.expunge_all()

    select_counts: list[int] = []

    def record_select(_connection, _cursor, statement, _parameters, _context, _many) -> None:
        if statement.lstrip().upper().startswith(("SELECT", "WITH")):
            select_counts[-1] += 1

    connection = db.get_bind()
    event.listen(connection, "before_cursor_execute", record_select)
    client = notification_client(db, owner)
    try:
        page_counts = []
        ordered_expected = sorted(expected_items, key=lambda item: item[0], reverse=True)
        for limit in (2, 4):
            db.expunge_all()
            select_counts.append(0)
            response = client.get(f"/api/notifications?limit={limit}")
            assert response.status_code == 200, response.text
            assert response.headers["cache-control"] == "private, no-store"
            page = response.json()
            assert page["pagination"] == {
                "limit": limit,
                "offset": 0,
                "count": limit,
                "total": 4,
                "has_more": limit < 4,
            }
            expected_page = ordered_expected[:limit]
            assert len(page["items"]) == limit
            assert [item["id"] for item in page["items"]] == [
                expected[1] for expected in expected_page
            ]
            assert {item["kind"] for item in page["items"]} == {
                "post-publish",
                "event-reminder",
            }
            for item, expected in zip(page["items"], expected_page, strict=True):
                _, expected_id, reference_fields, expected_keys = expected
                assert set(item) == expected_keys
                assert item["id"] == expected_id
                assert item["status"] == "unread"
                for field, value in reference_fields.items():
                    assert item[field] == value
            assert all(secret not in response.text for secret in private_content)
            page_counts.append(select_counts[-1])
    finally:
        event.remove(connection, "before_cursor_execute", record_select)

    assert page_counts[0] > 0
    assert page_counts[0] == page_counts[1]


def test_mark_read_is_audited_idempotent_and_rechecks_current_module_read(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = notification_actor(db)
    outsider = notification_actor(db)
    no_read = notification_actor(db, read=False)
    report, module = notification_report(db, owner)
    notice = report_notification(db, report, owner, minute=1)
    path = f"/api/notifications/{notice.id}/read"

    assert notification_client(db, outsider).post(path).status_code == 404
    assert notification_client(db, no_read).post(path).status_code == 404
    assert notification_client(db, None).post(path).status_code == 401
    assert notice.read_at is None
    grants = list(db.scalars(select(GroupAccess).where(GroupAccess.module_id == module.id)))
    for grant in grants:
        grant.is_deleted = True
        grant.deleted_at = datetime.now(UTC)
    db.flush()
    assert notification_client(db, owner).post(path).status_code == 404
    assert notice.read_at is None
    for grant in grants:
        grant.is_deleted = False
        grant.deleted_at = None
    db.flush()

    set_audit_actor(db, owner.id)
    first = notification_client(db, owner).post(path)
    assert first.status_code == 200
    assert first.headers["cache-control"] == "private, no-store"
    assert first.json()["status"] == "read"
    read_at = first.json()["read_at"]
    assert read_at is not None
    assert notification_client(db, owner).post(path).json()["read_at"] == read_at
    assert (
        db.scalar(
            select(AuditLog).where(
                AuditLog.entity_type == "in_app_notifications",
                AuditLog.entity_id == notice.id,
                AuditLog.action == "update",
            )
        )
        is not None
    )

    report.is_deleted = True
    report.deleted_at = datetime.now(UTC)
    db.flush()
    assert notification_client(db, owner).post(path).status_code == 404
    report.is_deleted = False
    report.deleted_at = None
    module.is_deleted = True
    module.deleted_at = datetime.now(UTC)
    db.flush()
    assert notification_client(db, owner).post(path).status_code == 404
    assert (
        notification_client(db, owner).post(f"/api/notifications/{uuid7()}/read").status_code == 404
    )
    assert UUID(first.json()["report_id"]) == report.id
