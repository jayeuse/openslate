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
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.openview.reports.models import ReportRunEligibleUser
from app.systems.platform.scheduling.execution import execute_due_report_runs
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork
from app.systems.platform.scheduling.notification_router import router as notification_router
from tests.conftest import membership_of
from tests.platform_scheduling.test_execution import NOW
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
