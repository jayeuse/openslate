"""Private immutable Report runs on runner-owned, committed PostgreSQL data."""

import csv
import importlib
import io
from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.access.policy.models import GroupMember
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.openview.reports.models import Report, ReportRun, ReportRunRow
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.reports.report_run_support import _RunFixture as _RunFixture
from tests.reports.report_run_support import report_run_fixture as report_run_fixture

pytestmark = pytest.mark.integration


def test_manual_report_run_freezes_grouped_csv_and_replays_key(
    report_run_fixture: _RunFixture,
) -> None:
    fixture = report_run_fixture
    key = uuid7()
    path = f"/api/reports/{fixture.report_id}/runs"
    created = fixture.client.post(path, headers=fixture.headers(key=key))
    assert created.status_code == 201, created.text
    body = created.json()
    run_id = UUID(body["id"])
    assert body["report_id"] == str(fixture.report_id)
    assert body["recipe_revision"] == 1
    assert body["row_count"] == 3
    assert body["headings"] == ["Category", "Note", "Amount"]
    assert created.headers["location"] == f"{path}/{run_id}"
    assert created.headers["cache-control"] == "private, no-store"

    csv_path = f"{path}/{run_id}/csv"
    first_csv = fixture.client.get(csv_path, headers=fixture.headers())
    assert first_csv.status_code == 200
    assert first_csv.headers["cache-control"] == "private, no-store"
    assert first_csv.headers["x-content-type-options"] == "nosniff"
    assert first_csv.headers["content-type"].startswith("text/csv")
    assert list(csv.reader(io.StringIO(first_csv.text))) == [
        ["Category", "Note", "Amount"],
        ["Group: Alpha", "", ""],
        ["Alpha", "ordinary", "9007199254740993"],
        ["Alpha", "'=SUM(1,1)", "1.25"],
        ["Group total: 2", "", ""],
        ["Group: Beta", "", ""],
        ["Beta", "completed", "2.5"],
        ["Group total: 1", "", ""],
        ["Grand total: 3", "", ""],
    ]

    with AuditSession(fixture.owner_engine) as writer:
        writer.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=fixture.owner_id,
            request_id=uuid7(),
            request_method="PATCH",
            request_path="/api/report-run-test/source-change",
        )
        record = writer.get(Record, fixture.first_record_id)
        assert record is not None
        record.data = {**record.data, str(fixture.note_field_id): "changed after run"}
        writer.commit()

    replay = fixture.client.post(path, headers=fixture.headers(key=key))
    assert replay.status_code == 201
    assert replay.json()["id"] == str(run_id)
    assert replay.headers["location"] == created.headers["location"]
    second_csv = fixture.client.get(csv_path, headers=fixture.headers())
    assert second_csv.content == first_csv.content
    with Session(fixture.owner_engine) as observer:
        assert (
            observer.scalar(
                select(func.count())
                .select_from(ReportRun)
                .where(ReportRun.report_id == fixture.report_id)
            )
            == 1
        )
        assert (
            observer.scalar(
                select(func.count()).select_from(ReportRunRow).where(ReportRunRow.run_id == run_id)
            )
            == 3
        )


def test_manual_report_run_denies_a_foreign_owner_and_a_guest(
    report_run_fixture: _RunFixture,
) -> None:
    fixture = report_run_fixture
    path = f"/api/reports/{fixture.report_id}/runs"
    assert fixture.client.post(path, headers=fixture.headers(key=uuid7())).status_code == 201
    foreign = fixture.client.post(
        path, headers=fixture.headers(fixture.outsider_token, key=uuid7())
    )
    assert foreign.status_code == 404
    guest = fixture.client.post(
        path, headers=fixture.headers(fixture.guest_token, key=uuid7())
    )
    assert guest.status_code == 403
    assert fixture.client.post(path, headers=fixture.headers()).status_code == 422
    malformed = fixture.client.post(
        path,
        headers={**fixture.headers(), "Idempotency-Key": "not-a-uuid"},
    )
    assert malformed.status_code == 422


def test_report_run_and_output_require_module_read_at_run_and_read_time(
    report_run_fixture: _RunFixture,
) -> None:
    fixture = report_run_fixture
    path = f"/api/reports/{fixture.report_id}/runs"
    first_key = uuid7()
    created = fixture.client.post(path, headers=fixture.headers(key=first_key))
    assert created.status_code == 201, created.text
    run_id = created.json()["id"]
    with AuditSession(fixture.owner_engine) as writer:
        writer.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=fixture.owner_id,
            request_id=uuid7(),
            request_method="DELETE",
            request_path="/api/report-run-test/access-boundary",
        )
        membership = writer.scalar(
            select(GroupMember).where(GroupMember.user_id == fixture.owner_id)
        )
        assert membership is not None
        writer.delete(membership)
        writer.commit()

    direct_query = fixture.client.post(
        "/api/records/query",
        headers=fixture.headers(),
        json={
            "module_id": str(fixture.module_id),
            "definition": {
                "version": 1,
                "columns": [{"field_id": str(fixture.note_field_id), "expected_type": "text"}],
            },
        },
    )
    assert direct_query.status_code == 404
    assert fixture.client.post(path, headers=fixture.headers(key=first_key)).status_code == 404
    assert fixture.client.post(path, headers=fixture.headers(key=uuid7())).status_code == 404
    assert fixture.client.get(path, headers=fixture.headers()).status_code == 404
    assert fixture.client.get(f"{path}/{run_id}", headers=fixture.headers()).status_code == 404
    assert fixture.client.get(f"{path}/{run_id}/csv", headers=fixture.headers()).status_code == 404
    shared = fixture.client.get("/api/reports/shared-runs", headers=fixture.headers())
    assert shared.status_code == 200
    assert shared.json()["pagination"]["total"] == 0
    with Session(fixture.owner_engine) as observer:
        assert (
            observer.scalar(
                select(func.count())
                .select_from(ReportRun)
                .where(ReportRun.report_id == fixture.report_id)
            )
            == 1
        )


def test_empty_grouped_run_is_frozen_and_unavailable_source_adds_no_run(
    report_run_fixture: _RunFixture,
) -> None:
    fixture = report_run_fixture
    with AuditSession(fixture.owner_engine) as writer:
        writer.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=fixture.owner_id,
            request_id=uuid7(),
            request_method="PATCH",
            request_path="/api/report-run-test/empty-recipe",
        )
        report = writer.get(Report, fixture.report_id)
        assert report is not None
        amount_reference = report.recipe["sorts"][0]
        report.recipe = {
            **report.recipe,
            "filters": [
                {
                    "field_id": amount_reference["field_id"],
                    "expected_type": amount_reference["expected_type"],
                    "operator": "gt",
                    "value": "999999999999999999999",
                }
            ],
        }
        report.revision += 1
        writer.commit()

    path = f"/api/reports/{fixture.report_id}/runs"
    created = fixture.client.post(path, headers=fixture.headers(key=uuid7()))
    assert created.status_code == 201, created.text
    assert created.json()["row_count"] == 0
    csv_result = fixture.client.get(f"{path}/{created.json()['id']}/csv", headers=fixture.headers())
    assert list(csv.reader(io.StringIO(csv_result.text))) == [
        ["Category", "Note", "Amount"],
        ["Grand total: 0", "", ""],
    ]

    with AuditSession(fixture.owner_engine) as writer:
        writer.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=fixture.owner_id,
            request_id=uuid7(),
            request_method="PATCH",
            request_path="/api/report-run-test/unavailable-module",
        )
        module = writer.get(Module, fixture.module_id)
        assert module is not None
        module.is_deleted = True
        module.deleted_at = datetime.now(UTC)
        writer.commit()
    denied = fixture.client.post(path, headers=fixture.headers(key=uuid7()))
    assert denied.status_code == 409
    assert denied.json()["detail"]["code"] == "report_invalid"
    with Session(fixture.owner_engine) as observer:
        assert (
            observer.scalar(
                select(func.count())
                .select_from(ReportRun)
                .where(ReportRun.report_id == fixture.report_id)
            )
            == 1
        )


def test_source_purged_after_snapshot_rolls_back_run_and_rows(
    report_run_fixture: _RunFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = report_run_fixture
    router_module = importlib.import_module("app.systems.openview.reports.router")
    original = router_module.capture_report_snapshot

    def purge_after_snapshot(engine: Engine, report_id: UUID, owner_id: UUID):
        snapshot = original(engine, report_id, owner_id)
        with AuditSession(fixture.owner_engine) as writer:
            writer.info[AUDIT_CONTEXT_KEY] = AuditContext(
                performed_by=fixture.owner_id,
                request_id=uuid7(),
                request_method="DELETE",
                request_path="/api/report-run-test/purge-race",
            )
            record = writer.get(Record, fixture.first_record_id)
            assert record is not None
            writer.delete(record)
            writer.commit()
        return snapshot

    monkeypatch.setattr(router_module, "capture_report_snapshot", purge_after_snapshot)
    created = fixture.client.post(
        f"/api/reports/{fixture.report_id}/runs",
        headers=fixture.headers(key=uuid7()),
    )
    assert created.status_code == 409
    assert created.json()["detail"]["code"] == "report_source_changed"
    with Session(fixture.owner_engine) as observer:
        assert (
            observer.scalar(
                select(func.count())
                .select_from(ReportRun)
                .where(ReportRun.report_id == fixture.report_id)
            )
            == 0
        )
        assert observer.scalar(select(func.count()).select_from(ReportRunRow)) == 0
