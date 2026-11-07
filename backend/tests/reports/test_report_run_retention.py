"""A report keeps its latest 30 runs, and what the sweep removes stays proven in the audit."""

import hashlib
from collections import Counter
from datetime import timedelta
from uuid import UUID

import pytest
from sqlalchemy import select, update
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.organization_scope import worker_organization
from app.systems.access.policy.models import AccessLevel, GroupAccess
from app.systems.access.users.models import User
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.openview.reports.models import (
    Report,
    ReportRun,
    ReportRunEligibleUser,
    ReportRunRow,
)
from app.systems.platform.scheduling import retention
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)
from app.systems.platform.scheduling.retention import sweep_organization
from app.systems.sandbox.records.models import Record
from tests.platform_scheduling.retention_support import NOW, sweep
from tests.platform_scheduling.support import report_work_subject
from tests.rbac.support import add_user
from tests.reports.report_run_support import _RunFixture as _RunFixture
from tests.reports.report_run_support import report_run_fixture as report_run_fixture

pytestmark = pytest.mark.integration


def _run(
    db: Session,
    report: Report,
    position: int,
    *,
    row_count: int = 0,
    age: timedelta | None = None,
) -> ReportRun:
    """The run at ``position``: 0 is the oldest of the report, and each run is 68 days or older."""

    content = f"Run {position}\r\n".encode()
    run = ReportRun(
        org_id=report.org_id,
        report_id=report.id,
        module_id=report.module_id,
        idempotency_key=uuid7(),
        recipe_revision=report.revision,
        recipe={},
        headings=[],
        row_count=row_count,
        csv_bytes=content,
        csv_sha256=hashlib.sha256(content).hexdigest(),
        created_at=NOW - (age or timedelta(days=100 - position)),
    )
    db.add(run)
    db.flush()
    return run


def _output(db: Session, run: ReportRun, reader: User) -> UUID:
    record = Record(org_id=run.org_id, module_id=run.module_id, data={})
    db.add(record)
    db.flush()
    row = ReportRunRow(
        org_id=run.org_id, run_id=run.id, position=0, record_id=record.id, cells=["Ready"]
    )
    db.add_all([row, ReportRunEligibleUser(org_id=run.org_id, run_id=run.id, user_id=reader.id)])
    db.flush()
    return row.id


def _work(db: Session, report: Report, run: ReportRun, recipients: list[User]) -> list[UUID]:
    work = ScheduledWork(
        org_id=report.org_id,
        kind=WorkKind.REPORT_RUN,
        report_id=report.id,
        scheduled_for=run.created_at,
        next_attempt_at=run.created_at,
        state=WorkState.SUCCEEDED,
        run_id=run.id,
    )
    db.add(work)
    db.flush()
    notifications = [
        InAppNotification(
            org_id=report.org_id,
            kind="report-run",
            subject_type="report_run",
            subject_id=run.id,
            work_id=work.id,
            recipient_id=recipient.id,
        )
        for recipient in recipients
    ]
    db.add_all(notifications)
    db.flush()
    return [notification.id for notification in notifications]


def test_a_report_keeps_its_latest_30_runs_and_the_audit_proves_the_rest_dbi13(
    integration_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # DBI-13: 32 runs leave 30. One is scheduled, with work and a notification; one is on demand.
    db = integration_db
    owner, report, _access, _module, _department = report_work_subject(db)
    runs = [_run(db, report, position) for position in range(32)]
    scheduled, on_demand, *latest = runs
    removed_ids = [scheduled.id, on_demand.id]
    latest_ids = [run.id for run in latest]
    hashes = {run.id: run.csv_sha256 for run in (scheduled, on_demand)}
    rows = [_output(db, run, owner) for run in (scheduled, on_demand)]
    kept_row = _output(db, latest[0], owner)
    notifications = _work(db, report, scheduled, [owner])
    kept_notifications = _work(db, report, latest[0], [owner])

    sweep(db, monkeypatch)

    remaining = db.scalars(select(ReportRun.id).where(ReportRun.report_id == report.id)).all()
    assert sorted(remaining) == sorted(latest_ids)
    assert db.scalars(select(ReportRunRow.id).where(ReportRunRow.id.in_(rows))).all() == []
    assert db.get(ReportRunRow, kept_row) is not None
    assert (
        db.scalars(
            select(ReportRunEligibleUser.user_id).where(
                ReportRunEligibleUser.run_id.in_(removed_ids)
            )
        ).all()
        == []
    )
    work = select(ScheduledWork.id).where(ScheduledWork.run_id.in_(removed_ids))
    assert db.scalars(work).all() == []
    notified = select(InAppNotification.id).where(
        InAppNotification.id.in_([*notifications, *kept_notifications])
    )
    assert db.scalars(notified).all() == kept_notifications

    audit = list(db.scalars(select(AuditLog).where(AuditLog.request_method == "RETENTION")))
    assert sorted((row.entity_type, row.entity_id) for row in audit) == sorted(
        [
            ("report_runs", removed_ids[0]),
            ("report_runs", removed_ids[1]),
            ("in_app_notifications", notifications[0]),
        ]
    )
    for row in audit:
        assert row.action == AuditAction.DELETE
        if row.entity_type == "report_runs":
            assert row.before["csv_sha256"] == hashes[row.entity_id]
            assert row.before["row_count"] == 0


def test_a_run_past_the_latest_30_goes_only_when_it_is_older_than_30_days_dbi13(
    integration_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_db
    _owner, report, _access, _module, _department = report_work_subject(db)
    old_enough = _run(db, report, 0, age=timedelta(days=30, seconds=1)).id
    at_the_limit = _run(db, report, 1, age=timedelta(days=30)).id
    latest = [_run(db, report, 2 + index, age=timedelta(days=1)).id for index in range(30)]

    sweep(db, monkeypatch)

    remaining = db.scalars(select(ReportRun.id).where(ReportRun.report_id == report.id)).all()
    assert sorted(remaining) == sorted([at_the_limit, *latest])
    assert old_enough not in remaining


def test_a_read_level_member_cannot_push_out_a_young_run_dbi13(
    report_run_fixture: _RunFixture,
) -> None:
    # DBI-13: any module reader can post runs, so a burst of them must not remove the history
    # of the last 30 days. The same run goes once it is 30 days old.
    fixture = report_run_fixture
    with fixture.owner_engine.begin() as connection:
        connection.execute(
            update(GroupAccess)
            .where(GroupAccess.module_id == fixture.module_id)
            .values(level=AccessLevel.READ.value)
        )
    path = f"/api/reports/{fixture.report_id}/runs"
    posted = []
    for _run_number in range(31):
        created = fixture.client.post(path, headers=fixture.headers(key=uuid7()))
        assert created.status_code == 201, created.text
        posted.append(UUID(created.json()["id"]))

    def stored_runs() -> list[UUID]:
        with fixture.owner_engine.connect() as connection:
            return list(
                connection.scalars(
                    select(ReportRun.id).where(ReportRun.report_id == fixture.report_id)
                )
            )

    with worker_organization(fixture.org_id):
        sweep_organization(fixture.runtime_engine)
        assert sorted(stored_runs()) == sorted(posted)

        sweep_organization(fixture.runtime_engine, now=utc_now() + timedelta(days=31))
        assert sorted(stored_runs()) == sorted(posted[1:])


def test_a_run_with_many_recipients_stays_within_the_audited_batch(
    integration_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A Large module has more readers than one batch. The notifications go in their own commits
    # first, because the run and its work row must leave in one transaction.
    db = integration_db
    owner, report, _access, _module, _department = report_work_subject(db)
    monkeypatch.setattr(retention, "AUDITED_BATCH", 3)
    monkeypatch.setattr(retention, "REPORT_RUNS_KEPT", 1)
    old, latest = _run(db, report, 0), _run(db, report, 1)
    readers = [owner, *[add_user(db) for _reader in range(4)]]
    _work(db, report, old, readers)
    old_id, latest_id = old.id, latest.id

    sweep(db, monkeypatch)

    assert db.scalars(select(ReportRun.id).where(ReportRun.report_id == report.id)).all() == [
        latest_id
    ]
    audit = db.scalars(select(AuditLog).where(AuditLog.request_method == "RETENTION")).all()
    per_commit = Counter(row.request_id for row in audit)
    assert sorted(per_commit.values()) == [3, 3]
    assert old_id in {row.entity_id for row in audit}


def test_a_large_run_uses_more_of_the_wake(
    integration_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A run holds up to MAX_ROWS (10,000) output rows, which costs 21 of a wake's 40 batches,
    # and the wake shares its thread with due Reports.
    db = integration_db
    _owner, report, _access, _module, _department = report_work_subject(db)
    monkeypatch.setattr(retention, "REPORT_RUNS_KEPT", 1)
    monkeypatch.setattr(retention, "BATCHES_PER_WAKE", 2)
    for position in range(3):
        _run(db, report, position, row_count=retention.REPORT_ROWS_PER_BATCH)
    latest = _run(db, report, 3)
    latest_id = latest.id

    sweep(db, monkeypatch)

    # The first run costs both batches of this wake, so the second one waits for the next wake.
    remaining = db.scalars(select(ReportRun.id).where(ReportRun.report_id == report.id)).all()
    assert len(remaining) == 3
    assert latest_id in remaining
