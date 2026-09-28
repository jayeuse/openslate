"""A Report deleted during snapshot capture cannot receive a late run."""

import importlib
from uuid import UUID

import pytest
from reports.test_report_run_routes import _RunFixture
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.openview.reports.models import Report, ReportRun, ReportRunRow

pytestmark = pytest.mark.integration
pytest_plugins = ("reports.test_report_run_routes",)


def test_run_started_before_permanent_report_delete_cannot_save_after_it(
    report_run_fixture: _RunFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture = report_run_fixture
    report_path = f"/api/reports/{fixture.report_id}"
    module = importlib.import_module("app.systems.openview.reports.router")
    capture = module.capture_report_snapshot

    def delete_after_snapshot(engine: Engine, report_id: UUID, actor_id: UUID | None):
        snapshot = capture(engine, report_id, actor_id)
        archived = fixture.client.delete(
            f"{report_path}?revision=1", headers=fixture.headers()
        )
        assert archived.status_code == 204, archived.text
        deleted = fixture.client.delete(
            f"{report_path}/permanent?revision=2", headers=fixture.headers()
        )
        assert deleted.status_code == 204, deleted.text
        return snapshot

    monkeypatch.setattr(module, "capture_report_snapshot", delete_after_snapshot)
    response = fixture.client.post(
        f"{report_path}/runs", headers=fixture.headers(key=uuid7())
    )
    assert response.status_code == 404
    with Session(fixture.owner_engine) as observer:
        assert observer.get(Report, fixture.report_id) is None
        assert observer.scalar(select(func.count()).select_from(ReportRun)) == 0
        assert observer.scalar(select(func.count()).select_from(ReportRunRow)) == 0
