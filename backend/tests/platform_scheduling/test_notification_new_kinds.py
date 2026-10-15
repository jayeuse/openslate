"""Current-source references for new kinds share all notification read boundaries."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from uuid6 import uuid7

from app.systems.access.users.membership import sole_active_membership
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork, WorkState
from tests.platform_scheduling.support import (
    assert_notice_hidden,
    notification_client,
    report_work_subject,
)

pytestmark = pytest.mark.integration
WHEN = datetime(2026, 10, 6, 12, tzinfo=UTC)


def test_failed_report_reference_is_visible_without_a_run_and_lost_access_hides_all_reads(
    integration_owner_db,
):
    db = integration_owner_db
    owner, report, grant, _module, _department = report_work_subject(db)
    work = ScheduledWork(
        org_id=report.org_id,
        report_id=report.id,
        scheduled_for=WHEN,
        next_attempt_at=WHEN,
        state=WorkState.FAILED,
        attempt_count=5,
        failure_code="attempts_exhausted",
    )
    db.add(work)
    db.flush()
    notice = InAppNotification(
        org_id=work.org_id,
        work_id=work.id,
        recipient_id=owner.id,
        kind="report-run-failed",
        subject_type="scheduled_work",
        subject_id=work.id,
    )
    db.add(notice)
    db.commit()
    client = notification_client(db, owner)
    count = client.get("/api/notifications/unread-count")
    assert count.status_code == 200, count.text
    assert count.json() == {"unread_count": 1}
    page = client.get("/api/notifications?status=unread")
    assert page.status_code == 200, page.text
    item = page.json()["items"][0]
    assert item["kind"] == "report-run-failed"
    assert item["subject_type"] == "scheduled_work" and item["subject_id"] == str(work.id)
    assert item["report_id"] == str(report.id)
    assert item["scheduled_for"] == "2026-10-06T12:00:00Z"
    assert "run_id" not in item and "work_id" not in item
    marked = client.post(f"/api/notifications/{notice.id}/read")
    assert marked.status_code == 200, marked.text
    assert marked.json()["status"] == "read"
    grant.is_deleted = True
    db.commit()
    assert_notice_hidden(client, notice.id)
    assert notification_client(db, None).get("/api/notifications/unread-count").status_code == 401
    assert (
        len(list(db.scalars(select(InAppNotification).where(InAppNotification.work_id == work.id))))
        == 1
    )


@pytest.mark.parametrize(
    ("kind", "subject_type"),
    [
        ("report-run-failed", "scheduled_work"),
        ("backup-failed", "backup_run"),
        ("record-assigned", "record"),
        ("invitation-accepted", "user"),
        ("sandbox-published", "sandbox_version"),
        ("access-changed", "user"),
    ],
)
def test_invalid_current_source_or_archived_notice_is_hidden_before_all_read_boundaries(
    integration_owner_db, kind, subject_type
):
    db = integration_owner_db
    owner, report, _grant, _module, _department = report_work_subject(db)
    sole_active_membership(db, owner.id).role = "admin"
    work = None
    subject_id = uuid7()
    if kind == "report-run-failed":
        # Correct tuple, but the actual work is still pending, not exhausted.
        work = ScheduledWork(
            org_id=report.org_id, report_id=report.id,
            scheduled_for=WHEN, next_attempt_at=WHEN,
        )
        db.add(work)
        db.flush()
        subject_id = work.id
    elif kind == "access-changed":
        subject_id = owner.id
    notice = InAppNotification(
        org_id=None if kind == "backup-failed" else report.org_id,
        kind=kind,
        subject_type=subject_type,
        subject_id=subject_id,
        work_id=work.id if work is not None else None,
        recipient_id=owner.id,
        is_deleted=kind == "access-changed",
    )
    db.add(notice)
    db.commit()
    client = notification_client(db, owner)
    assert client.get("/api/notifications?limit=1&status=unread").json() == {
        "items": [],
        "pagination": {"limit": 1, "offset": 0, "count": 0, "total": 0, "has_more": False},
    }
    assert_notice_hidden(client, notice.id)
    db.refresh(notice)
    assert notice.read_at is None
