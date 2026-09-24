"""Current-recipient Report notification HTTP access on disposable PostgreSQL."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditLog
from app.systems.openview.reports.models import Report, ReportRun, ReportRunEligibleUser
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork, WorkState
from app.systems.platform.scheduling.notification_router import router
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module

pytestmark = pytest.mark.integration


def _actor(db: Session, *, read: bool = True) -> User:
    suffix = uuid7().hex
    role = Role(role=f"notification-{suffix}", permissions={"records.read": read})
    actor = User(
        email=f"notification-{suffix}@example.test",
        username=f"notification_{suffix[:16]}",
        status=UserStatus.ACTIVE.value,
        role=role,
    )
    db.add(actor)
    db.flush()
    return actor


def _report(db: Session, owner: User) -> tuple[Report, Module]:
    department = Department(department_name=f"Notification {uuid7().hex}")
    db.add(department)
    db.flush()
    module = Module(
        department_id=department.id,
        module_name=f"Notification {uuid7().hex}",
        is_schema_accepted=True,
    )
    db.add(module)
    db.flush()
    report = Report(owner_id=owner.id, module_id=module.id, name="Secret Report", recipe={})
    db.add(report)
    db.flush()
    return report, module


def _notification(db: Session, report: Report, *, minute: int) -> InAppNotification:
    when = datetime(2026, 1, 1, tzinfo=UTC) + timedelta(minutes=minute)
    work = ScheduledWork(
        report_id=report.id,
        scheduled_for=when,
        next_attempt_at=when,
        state=WorkState.PENDING,
    )
    db.add(work)
    db.flush()
    run = ReportRun(
        report_id=report.id,
        module_id=report.module_id,
        idempotency_key=work.id,
        recipe_revision=1,
        recipe={},
        headings=[],
        row_count=0,
        csv_bytes=b"SECRET OUTPUT",
    )
    db.add(run)
    db.flush()
    db.add(ReportRunEligibleUser(run_id=run.id, user_id=report.owner_id))
    work.run_id = run.id
    work.state = WorkState.SUCCEEDED
    notification = InAppNotification(
        work_id=work.id,
        recipient_id=report.owner_id,
        created_at=when,
    )
    db.add(notification)
    db.flush()
    return notification


def _client(db: Session, actor: User | None) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    if actor is not None:
        app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def test_notification_list_is_actor_scoped_bounded_and_reference_only(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    outsider = _actor(db)
    no_read = _actor(db, read=False)
    report, _module = _report(db, owner)
    first = _notification(db, report, minute=1)
    second = _notification(db, report, minute=2)
    hidden_report, _ = _report(db, owner)
    hidden = _notification(db, hidden_report, minute=3)
    hidden_report.audience_kind = "user"
    hidden_report.audience_user_id = outsider.id
    db.flush()

    response = _client(db, owner).get("/api/notifications?limit=1&offset=0")
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
        "report_id",
        "run_id",
        "status",
        "scheduled_for",
        "created_at",
        "read_at",
    }
    assert response.json()["items"][0]["kind"] == "report-run"
    assert response.json()["items"][0]["status"] == "unread"
    assert "SECRET OUTPUT" not in response.text
    assert "Secret Report" not in response.text
    assert str(hidden.id) not in response.text

    page = _client(db, owner).get("/api/notifications?limit=1&offset=1")
    assert page.status_code == 200
    assert [item["id"] for item in page.json()["items"]] == [str(first.id)]
    assert page.json()["pagination"]["has_more"] is False
    outsider_page = _client(db, outsider).get("/api/notifications")
    assert outsider_page.status_code == 200
    assert outsider_page.json()["pagination"]["total"] == 0
    assert _client(db, no_read).get("/api/notifications").status_code == 403
    assert _client(db, None).get("/api/notifications").status_code == 401
    for query in ("limit=0", "limit=101", "offset=-1", "sort_order=asc"):
        assert _client(db, owner).get(f"/api/notifications?{query}").status_code == 422


def test_mark_read_is_audited_idempotent_and_rechecks_current_audience(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    outsider = _actor(db)
    no_read = _actor(db, read=False)
    report, module = _report(db, owner)
    notice = _notification(db, report, minute=1)
    path = f"/api/notifications/{notice.id}/read"

    assert _client(db, outsider).post(path).status_code == 404
    assert _client(db, no_read).post(path).status_code == 403
    assert _client(db, None).post(path).status_code == 401
    assert notice.read_at is None
    report.audience_kind = "user"
    report.audience_user_id = outsider.id
    db.flush()
    assert _client(db, owner).post(path).status_code == 404
    assert notice.read_at is None
    report.audience_kind = "private"
    report.audience_user_id = None
    db.flush()

    set_audit_actor(db, owner.id)
    first = _client(db, owner).post(path)
    assert first.status_code == 200
    assert first.headers["cache-control"] == "private, no-store"
    assert first.json()["status"] == "read"
    read_at = first.json()["read_at"]
    assert read_at is not None
    assert _client(db, owner).post(path).json()["read_at"] == read_at
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
    assert _client(db, owner).post(path).status_code == 404
    report.is_deleted = False
    report.deleted_at = None
    module.is_deleted = True
    module.deleted_at = datetime.now(UTC)
    db.flush()
    assert _client(db, owner).post(path).status_code == 404
    assert _client(db, owner).post(f"/api/notifications/{uuid7()}/read").status_code == 404
    assert UUID(first.json()["report_id"]) == report.id
