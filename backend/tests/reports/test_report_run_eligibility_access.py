"""Run-time reader snapshots and current module read checks using real bearer auth.

Every module reader at run time may open a run, while they can still read the module.
"""

from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database import get_db
from app.core.database.session import AuditSession
from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.access.users.models import User
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.openview.reports.models import Report, ReportRun, ReportRunEligibleUser
from app.systems.platform.scheduling.execution import execute_due_report_runs
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork
from app.systems.platform.scheduling.notification_router import router as notification_router
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from tests.conftest import membership_of
from tests.platform_scheduling.test_execution import NOW
from tests.rbac.support import make_group_access
from tests.reports.report_run_support import report_route_recipe
from tests.reports.test_report_run_routes import _RunFixture

pytestmark = pytest.mark.integration
pytest_plugins = ("tests.platform_scheduling.test_execution",)


def test_expired_identity_is_not_captured_for_new_report_run(
    report_run_fixture: _RunFixture,
) -> None:
    fixture = report_run_fixture
    outsider_id = fixture.outsider_id
    with Session(fixture.owner_engine) as db:
        outsider = membership_of(db, outsider_id)
        assert outsider is not None
        outsider.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        db.commit()

    created = fixture.client.post(
        f"/api/reports/{fixture.report_id}/runs",
        headers=fixture.headers(key=uuid7()),
    )
    assert created.status_code == 201, created.text
    with Session(fixture.owner_engine) as db:
        assert db.get(ReportRunEligibleUser, (UUID(created.json()["id"]), outsider_id)) is None


def test_every_module_reader_opens_a_run_until_they_lose_module_read(
    report_run_fixture: _RunFixture,
) -> None:
    """S3-7 and S4-5: the roster is the module readers; a lost read hides the run."""

    fixture = report_run_fixture
    path = f"/api/reports/{fixture.report_id}/runs"
    created = fixture.client.post(path, headers=fixture.headers(key=uuid7()))
    assert created.status_code == 201, created.text
    run_id = UUID(created.json()["id"])
    outsider_headers = fixture.headers(fixture.outsider_token)
    guest_headers = fixture.headers(fixture.guest_token)
    with Session(fixture.owner_engine) as db:
        for user_id in (fixture.owner_id, fixture.outsider_id, fixture.guest_id):
            assert db.get(ReportRunEligibleUser, (run_id, user_id)) is not None

    for headers in (outsider_headers, guest_headers):
        assert fixture.client.get(f"{path}/{run_id}", headers=headers).status_code == 200
        exported = fixture.client.get(f"{path}/{run_id}/csv", headers=headers)
        assert exported.status_code == 200
        assert exported.headers["cache-control"] == "private, no-store"
    discovery = fixture.client.get("/api/reports/shared-runs", headers=outsider_headers)
    assert discovery.status_code == 200
    assert [item["id"] for item in discovery.json()["items"]] == [str(run_id)]
    assert discovery.json()["items"][0]["report_name"] == "Operations snapshot"
    assert "recipe" not in discovery.json()["items"][0]

    with fixture.owner_engine.begin() as writer:
        writer.execute(
            text("DELETE FROM public.group_members WHERE user_id = :id"),
            {"id": fixture.outsider_id},
        )
    assert fixture.client.get(f"{path}/{run_id}", headers=outsider_headers).status_code == 404
    assert fixture.client.get(f"{path}/{run_id}/csv", headers=outsider_headers).status_code == 404
    assert fixture.client.get(path, headers=outsider_headers).status_code == 404
    shared = fixture.client.get("/api/reports/shared-runs", headers=outsider_headers)
    assert shared.json()["pagination"]["total"] == 0
    assert fixture.client.get(f"{path}/{run_id}", headers=guest_headers).status_code == 200


def test_missing_roster_and_lost_current_capability_fail_closed(
    report_run_fixture: _RunFixture,
) -> None:
    fixture = report_run_fixture
    path = f"/api/reports/{fixture.report_id}/runs"
    key = uuid7()
    created = fixture.client.post(path, headers=fixture.headers(key=key))
    assert created.status_code == 201, created.text
    run_id = UUID(created.json()["id"])
    with Session(fixture.owner_engine) as db:
        roster = db.get(ReportRunEligibleUser, (run_id, fixture.owner_id))
        assert roster is not None
        db.delete(roster)
        db.commit()
    assert fixture.client.get(f"{path}/{run_id}", headers=fixture.headers()).status_code == 404
    assert fixture.client.get(f"{path}/{run_id}/csv", headers=fixture.headers()).status_code == 404
    assert fixture.client.get(path, headers=fixture.headers()).json()["pagination"]["total"] == 0
    assert fixture.client.post(path, headers=fixture.headers(key=key)).status_code == 404


def test_roster_includes_a_reading_guest_and_excludes_a_user_without_module_read(
    report_run_fixture: _RunFixture,
) -> None:
    fixture = report_run_fixture
    path = f"/api/reports/{fixture.report_id}/runs"
    run = fixture.client.post(path, headers=fixture.headers(key=uuid7()))
    assert run.status_code == 201, run.text
    run_id = UUID(run.json()["id"])
    with Session(fixture.owner_engine) as db:
        assert db.get(ReportRunEligibleUser, (run_id, fixture.guest_id)) is not None

    with fixture.owner_engine.begin() as writer:
        writer.execute(
            text("DELETE FROM public.group_members WHERE user_id = :id"),
            {"id": fixture.outsider_id},
        )
    second = fixture.client.post(path, headers=fixture.headers(key=uuid7()))
    assert second.status_code == 201, second.text
    second_id = UUID(second.json()["id"])
    with Session(fixture.owner_engine) as db:
        assert db.get(ReportRunEligibleUser, (second_id, fixture.guest_id)) is not None
        assert db.get(ReportRunEligibleUser, (second_id, fixture.outsider_id)) is None


def test_scheduled_run_notifies_each_reader_until_they_lose_module_read(
    scheduled_report: _RunFixture,
) -> None:
    fixture = scheduled_report
    outsider_id = fixture.outsider_id

    completed = execute_due_report_runs(fixture.runtime_engine, now=NOW)
    assert len(completed) == 1
    run_id = completed[0]
    assert execute_due_report_runs(fixture.runtime_engine, now=NOW) == []
    with Session(fixture.owner_engine) as db:
        work = db.scalar(select(ScheduledWork).where(ScheduledWork.report_id == fixture.report_id))
        assert work is not None
        notices = db.scalars(
            select(InAppNotification).where(InAppNotification.work_id == work.id)
        ).all()
        assert {notice.recipient_id for notice in notices} == {
            fixture.owner_id,
            outsider_id,
            fixture.guest_id,
        }

    app = FastAPI()
    app.include_router(notification_router, prefix="/api")

    def database(request: Request) -> Generator[Session, None, None]:
        with AuditSession(fixture.runtime_engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                request_id=uuid7(), request_method=request.method, request_path=request.url.path
            )
            yield db

    app.dependency_overrides[get_db] = database
    with TestClient(app) as client:
        outsider_page = client.get(
            "/api/notifications", headers=fixture.headers(fixture.outsider_token)
        )
        assert outsider_page.status_code == 200, outsider_page.text
        assert outsider_page.headers["cache-control"] == "private, no-store"
        assert outsider_page.json()["pagination"]["total"] == 1
        assert client.get(
            "/api/notifications/unread-count", headers=fixture.headers(fixture.outsider_token)
        ).json() == {"unread_count": 1}
        notice = outsider_page.json()["items"][0]
        assert notice["kind"] == "report-run"
        assert notice["report_id"] == str(fixture.report_id)
        assert notice["run_id"] == str(run_id)
        assert notice["subject_type"] == "report_run"
        assert notice["subject_id"] == str(run_id)
        assert set(notice) == {
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
        csv_path = f"/api/reports/{fixture.report_id}/runs/{run_id}/csv"
        outsider_headers = fixture.headers(fixture.outsider_token)
        assert fixture.client.get(csv_path, headers=outsider_headers).status_code == 200

        with fixture.owner_engine.begin() as writer:
            writer.execute(
                text("DELETE FROM public.group_members WHERE user_id = :id"),
                {"id": outsider_id},
            )
        hidden = client.get("/api/notifications", headers=outsider_headers)
        assert hidden.status_code == 200
        assert hidden.json()["pagination"]["total"] == 0
        assert client.get("/api/notifications/unread-count", headers=outsider_headers).json() == {
            "unread_count": 0
        }
        assert client.post("/api/notifications/read-all", headers=outsider_headers).json() == {
            "updated_count": 0
        }
        with Session(fixture.owner_engine) as observed:
            assert observed.get(InAppNotification, UUID(notice["id"])).read_at is None
        assert fixture.client.get(csv_path, headers=outsider_headers).status_code == 404
        owner_page = client.get("/api/notifications", headers=fixture.headers())
        assert owner_page.json()["pagination"]["total"] == 1


@pytest.fixture
def moved_report_run(
    scheduled_report: _RunFixture,
) -> Generator[tuple[_RunFixture, UUID, UUID, bytes], None, None]:
    fixture = scheduled_report
    completed = execute_due_report_runs(fixture.runtime_engine, now=NOW)
    assert len(completed) == 1
    run_id = completed[0]
    csv_path = f"/api/reports/{fixture.report_id}/runs/{run_id}/csv"
    original_csv = fixture.client.get(csv_path, headers=fixture.headers()).content
    fixture.client.app.include_router(notification_router, prefix="/api")

    with AuditSession(fixture.owner_engine) as db:
        db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
        source = db.get(Module, fixture.module_id)
        assert source is not None
        department = db.get(Department, source.department_id)
        assert department is not None
        destination = Module(
            org_id=fixture.org_id,
            department_id=department.id,
            module_name=f"Report destination {uuid7()}",
        )
        db.add(destination)
        db.flush()
        field = Field(
            org_id=fixture.org_id,
            module_id=destination.id,
            name="Destination category",
            type=FieldType.TEXT,
            required=False,
            position=0,
            config={},
        )
        db.add(field)
        users = db.scalars(
            select(User).where(
                User.id.in_([fixture.owner_id, fixture.outsider_id, fixture.guest_id])
            )
        ).all()
        grant = make_group_access(db, users, department, destination, level="manage")
        db.commit()
        destination_id, field_id, grant_id, group_id = (
            destination.id, field.id, grant.id, grant.group_id
        )
        recipe = report_route_recipe(field)
        run = db.get(ReportRun, run_id)
        assert run is not None
        key = run.idempotency_key

    try:
        moved = fixture.client.patch(
            f"/api/reports/{fixture.report_id}",
            headers=fixture.headers(),
            json={"revision": 1, "module_id": str(destination_id), "recipe": recipe},
        )
        assert moved.status_code == 200, moved.text
        assert moved.json()["module_id"] == str(destination_id)
        outsider_headers = fixture.headers(fixture.outsider_token)
        assert fixture.client.get(csv_path, headers=outsider_headers).status_code == 200
        with AuditSession(fixture.owner_engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            membership = db.scalar(
                select(GroupMember)
                .join(GroupAccess, GroupAccess.group_id == GroupMember.group_id)
                .where(
                    GroupMember.user_id == fixture.outsider_id,
                    GroupAccess.module_id == fixture.module_id,
                )
            )
            assert membership is not None
            membership.is_deleted = True
            membership.deleted_at = datetime.now(UTC)
            db.commit()
        assert fixture.client.get(
            f"/api/reports/{fixture.report_id}", headers=outsider_headers
        ).status_code == 200
        yield fixture, run_id, key, original_csv
    finally:
        with AuditSession(fixture.owner_engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            run = db.get(ReportRun, run_id)
            assert run is not None
            assert run.module_id == fixture.module_id
            assert run.csv_bytes == original_csv
            assert db.get(ReportRunEligibleUser, (run_id, fixture.outsider_id)) is not None
            assert list(db.scalars(
                select(ReportRun.id).where(ReportRun.report_id == fixture.report_id)
            )) == [run_id]
            report = db.get(Report, fixture.report_id)
            assert report is not None
            report.module_id = fixture.module_id
            db.flush()
            db.delete(db.get(GroupAccess, grant_id))
            for member in db.scalars(select(GroupMember).where(GroupMember.group_id == group_id)):
                db.delete(member)
            db.flush()
            db.delete(db.get(Group, group_id))
            db.delete(db.get(Field, field_id))
            db.flush()
            db.delete(db.get(Module, destination_id))
            db.commit()


@pytest.mark.parametrize("surface", ["detail", "csv", "runs", "shared", "replay"])
def test_retained_run_reads_require_captured_module_read(
    moved_report_run: tuple[_RunFixture, UUID, UUID, bytes], surface: str,
) -> None:
    fixture, run_id, key, original_csv = moved_report_run
    path = f"/api/reports/{fixture.report_id}/runs"
    paths = {
        "detail": f"{path}/{run_id}",
        "csv": f"{path}/{run_id}/csv",
        "runs": f"{path}?limit=1",
        "shared": "/api/reports/shared-runs?limit=1",
        "replay": path,
    }

    # A guest's current READ on both modules is enough for output; replay is non-guest.
    reader_token = fixture.owner_token if surface == "replay" else fixture.guest_token
    allowed_headers = fixture.headers(reader_token, key=key)
    denied_headers = fixture.headers(fixture.outsider_token, key=key)
    request = fixture.client.post if surface == "replay" else fixture.client.get
    allowed = request(paths[surface], headers=allowed_headers)
    assert allowed.status_code == (201 if surface == "replay" else 200), allowed.text
    if surface == "csv":
        assert allowed.content == original_csv
        assert b"ordinary" in allowed.content
    elif surface in {"runs", "shared"}:
        assert [item["id"] for item in allowed.json()["items"]] == [str(run_id)]
        assert allowed.json()["pagination"]["total"] == 1
    else:
        assert allowed.json()["id"] == str(run_id)
        assert allowed.json()["row_count"] == 3

    denied = request(paths[surface], headers=denied_headers)
    if surface in {"runs", "shared"}:
        assert denied.status_code == 200
        assert denied.json()["items"] == []
        assert denied.json()["pagination"] == {
            "limit": 1, "offset": 0, "count": 0, "total": 0, "has_more": False
        }
    else:
        assert denied.status_code == 404
        assert denied.json() == {"detail": "Report run not found"}


def test_report_notifications_require_captured_module_read(
    moved_report_run: tuple[_RunFixture, UUID, UUID, bytes],
) -> None:
    fixture, run_id, _key, _original_csv = moved_report_run
    client = fixture.client
    guest_headers = fixture.headers(fixture.guest_token)
    visible = client.get("/api/notifications", headers=guest_headers)
    assert visible.status_code == 200, visible.text
    assert visible.json()["pagination"]["total"] == 1
    assert visible.json()["items"][0]["run_id"] == str(run_id)
    assert client.get("/api/notifications/unread-count", headers=guest_headers).json() == {
        "unread_count": 1
    }
    with Session(fixture.owner_engine) as db:
        notice = db.scalar(select(InAppNotification).where(
            InAppNotification.recipient_id == fixture.outsider_id,
            InAppNotification.subject_id == run_id,
        ))
        assert notice is not None
        notice_id = notice.id

    headers = fixture.headers(fixture.outsider_token)
    hidden = client.get("/api/notifications", headers=headers)
    assert hidden.status_code == 200
    assert hidden.json()["items"] == []
    assert hidden.json()["pagination"]["total"] == 0
    assert client.get("/api/notifications/unread-count", headers=headers).json() == {
        "unread_count": 0
    }
    assert client.post("/api/notifications/read-all", headers=headers).json() == {
        "updated_count": 0
    }
    assert client.post(f"/api/notifications/{notice_id}/read", headers=headers).status_code == 404
    with Session(fixture.owner_engine) as db:
        assert db.get(InAppNotification, notice_id).read_at is None
