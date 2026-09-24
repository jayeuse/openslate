"""Run-time recipient snapshots and current audience checks using real bearer auth."""

from collections.abc import Generator
from uuid import UUID

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database import get_db
from app.core.database.session import AuditSession
from app.core.security.tokens import TokenType, decode_token
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.openview.reports.models import ReportRunEligibleUser
from app.systems.platform.scheduling.execution import execute_due_report_runs
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork
from app.systems.platform.scheduling.notification_router import router as notification_router
from tests.platform_scheduling.test_execution import NOW
from tests.reports.test_report_run_routes import _RunFixture

pytestmark = pytest.mark.integration
pytest_plugins = ("tests.platform_scheduling.test_execution",)


def test_audience_expansion_grants_only_future_runs_and_current_access(
    report_run_fixture: _RunFixture,
) -> None:
    fixture = report_run_fixture
    path = f"/api/reports/{fixture.report_id}/runs"
    first_key = uuid7()
    first = fixture.client.post(path, headers=fixture.headers(key=first_key))
    assert first.status_code == 201, first.text
    first_id = UUID(first.json()["id"])
    outsider_claims = decode_token(fixture.outsider_token, TokenType.ACCESS)
    assert outsider_claims is not None
    outsider_id = UUID(str(outsider_claims["sub"]))
    with Session(fixture.owner_engine) as db:
        assert db.get(ReportRunEligibleUser, (first_id, fixture.owner_id)) is not None
        assert db.get(ReportRunEligibleUser, (first_id, outsider_id)) is None

    expanded = fixture.client.patch(
        f"/api/reports/{fixture.report_id}",
        headers=fixture.headers(),
        json={"revision": 1, "audience": {"kind": "everyone"}},
    )
    assert expanded.status_code == 200, expanded.text
    outsider_headers = fixture.headers(fixture.outsider_token)
    assert fixture.client.get(f"{path}/{first_id}", headers=outsider_headers).status_code == 404
    assert fixture.client.get(f"{path}/{first_id}/csv", headers=outsider_headers).status_code == 404
    assert fixture.client.get(path, headers=outsider_headers).json()["pagination"]["total"] == 0

    second_key = uuid7()
    second = fixture.client.post(path, headers=fixture.headers(key=second_key))
    assert second.status_code == 201, second.text
    second_id = UUID(second.json()["id"])
    with Session(fixture.owner_engine) as db:
        assert db.get(ReportRunEligibleUser, (second_id, outsider_id)) is not None
    assert fixture.client.get(f"{path}/{second_id}", headers=outsider_headers).status_code == 200
    exported = fixture.client.get(f"{path}/{second_id}/csv", headers=outsider_headers)
    assert exported.status_code == 200
    assert exported.headers["cache-control"] == "private, no-store"
    listing = fixture.client.get(path, headers=outsider_headers)
    assert listing.status_code == 200
    assert [item["id"] for item in listing.json()["items"]] == [str(second_id)]
    discovery = fixture.client.get("/api/reports/shared-runs", headers=outsider_headers)
    assert discovery.status_code == 200
    assert discovery.headers["cache-control"] == "private, no-store"
    assert [item["id"] for item in discovery.json()["items"]] == [str(second_id)]
    assert discovery.json()["items"][0]["report_name"] == "Operations snapshot"
    assert discovery.json()["items"][0]["status"] == "succeeded"
    assert "recipe" not in discovery.json()["items"][0]

    narrowed = fixture.client.patch(
        f"/api/reports/{fixture.report_id}",
        headers=fixture.headers(),
        json={"revision": 2, "audience": {"kind": "user", "user_id": str(outsider_id)}},
    )
    assert narrowed.status_code == 200, narrowed.text
    assert fixture.client.get(f"{path}/{second_id}", headers=fixture.headers()).status_code == 404
    assert fixture.client.post(path, headers=fixture.headers(key=second_key)).status_code == 404
    assert fixture.client.get(f"{path}/{second_id}", headers=outsider_headers).status_code == 200


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


def test_roster_excludes_write_only_profiles(report_run_fixture: _RunFixture) -> None:
    fixture = report_run_fixture
    path = f"/api/reports/{fixture.report_id}/runs"
    changed = fixture.client.patch(
        f"/api/reports/{fixture.report_id}",
        headers=fixture.headers(),
        json={"revision": 1, "audience": {"kind": "everyone"}},
    )
    assert changed.status_code == 200, changed.text
    run = fixture.client.post(path, headers=fixture.headers(key=uuid7()))
    assert run.status_code == 201, run.text
    run_id = UUID(run.json()["id"])
    claims = decode_token(fixture.write_only_token, TokenType.ACCESS)
    assert claims is not None
    write_only_id = UUID(str(claims["sub"]))
    with Session(fixture.owner_engine) as db:
        assert db.get(ReportRunEligibleUser, (run_id, write_only_id)) is None


def test_owner_excluded_schedule_delivers_one_reference_only_notice_to_eligible_reader(
    scheduled_report: _RunFixture,
) -> None:
    fixture = scheduled_report
    outsider_claims = decode_token(fixture.outsider_token, TokenType.ACCESS)
    assert outsider_claims is not None
    outsider_id = UUID(str(outsider_claims["sub"]))
    changed = fixture.client.patch(
        f"/api/reports/{fixture.report_id}",
        headers=fixture.headers(),
        json={"revision": 1, "audience": {"kind": "user", "user_id": str(outsider_id)}},
    )
    assert changed.status_code == 200, changed.text

    completed = execute_due_report_runs(fixture.runtime_engine, now=NOW)
    assert len(completed) == 1
    run_id = completed[0]
    assert execute_due_report_runs(fixture.runtime_engine, now=NOW) == []
    with Session(fixture.owner_engine) as db:
        roster = db.get(ReportRunEligibleUser, (run_id, outsider_id))
        assert roster is not None
        assert db.get(ReportRunEligibleUser, (run_id, fixture.owner_id)) is None
        work = db.scalar(select(ScheduledWork).where(ScheduledWork.report_id == fixture.report_id))
        assert work is not None
        notices = db.scalars(
            select(InAppNotification).where(InAppNotification.work_id == work.id)
        ).all()
        assert [notice.recipient_id for notice in notices] == [outsider_id]

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
        notice = outsider_page.json()["items"][0]
        assert notice["kind"] == "report-run"
        assert notice["report_id"] == str(fixture.report_id)
        assert notice["run_id"] == str(run_id)
        assert set(notice) == {
            "id",
            "kind",
            "report_id",
            "run_id",
            "status",
            "scheduled_for",
            "created_at",
            "read_at",
        }
        owner_page = client.get("/api/notifications", headers=fixture.headers())
        assert owner_page.status_code == 200
        assert owner_page.json()["pagination"]["total"] == 0

    csv_path = f"/api/reports/{fixture.report_id}/runs/{run_id}/csv"
    assert (
        fixture.client.get(csv_path, headers=fixture.headers(fixture.outsider_token)).status_code
        == 200
    )
    assert fixture.client.get(csv_path, headers=fixture.headers()).status_code == 404
