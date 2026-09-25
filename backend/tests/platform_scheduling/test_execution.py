"""Committed scheduled Report execution against runner-owned PostgreSQL."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import bindparam, func, select, text
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.core.security.tokens import TokenType, decode_token
from app.systems.access.policy.models import AccessRule
from app.systems.access.users.models import Role, User
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.openview.reports.models import (
    Report,
    ReportRun,
    ReportRunEligibleUser,
    ReportRunRow,
)
from app.systems.openview.reports.run_service import capture_report_snapshot
from app.systems.openview.reports.schedule_models import ReportSchedule
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork, WorkState
from app.systems.platform.scheduling.service import claim_due_work
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record

pytestmark = pytest.mark.integration
pytest_plugins = ("tests.reports.test_report_run_routes",)
NOW = datetime(2026, 1, 1, 12, tzinfo=UTC)


@pytest.fixture
def scheduled_report(report_run_fixture):
    subject = report_run_fixture
    with AuditSession(subject.owner_engine) as db:
        db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
        schedule = ReportSchedule(
            report_id=subject.report_id,
            enabled=True,
            cadence="daily",
            timezone_name="UTC",
            local_time=NOW.time().replace(tzinfo=None),
            next_due_at=NOW,
        )
        db.add(schedule)
        db.commit()
        schedule_id = schedule.id
    try:
        yield subject
    finally:
        audited_ids = {schedule_id}
        with AuditSession(subject.owner_engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            run_ids = list(
                db.scalars(select(ReportRun.id).where(ReportRun.report_id == subject.report_id))
            )
            audited_ids.update(run_ids)
            if run_ids:
                audited_ids.update(
                    db.scalars(select(ReportRunRow.id).where(ReportRunRow.run_id.in_(run_ids)))
                )
            for work in db.scalars(
                select(ScheduledWork).where(ScheduledWork.report_id == subject.report_id)
            ):
                for notice in db.scalars(
                    select(InAppNotification).where(InAppNotification.work_id == work.id)
                ):
                    audited_ids.add(notice.id)
                    db.delete(notice)
                db.flush()
                db.delete(work)
            schedule = db.get(ReportSchedule, schedule_id)
            if schedule is not None:
                db.delete(schedule)
            db.commit()
        # Immutable audit rows are removed only by the disposable fixture's
        # owner-only teardown, matching the shared Report run fixture.
        with subject.owner_engine.begin() as connection:
            connection.execute(
                text("DELETE FROM public.audit_logs WHERE entity_id IN :ids").bindparams(
                    bindparam("ids", expanding=True)
                ),
                {"ids": list(audited_ids)},
            )


def _counts(db: AuditSession, report_id):
    runs = db.scalar(
        select(func.count()).select_from(ReportRun).where(ReportRun.report_id == report_id)
    )
    notices = db.scalar(
        select(func.count())
        .select_from(InAppNotification)
        .join(ScheduledWork, ScheduledWork.id == InAppNotification.work_id)
        .where(ScheduledWork.report_id == report_id)
    )
    return runs, notices


def test_due_report_commits_frozen_run_rows_work_and_one_notification(scheduled_report):
    from app.systems.platform.scheduling.execution import execute_due_report_runs

    subject = scheduled_report
    expected = capture_report_snapshot(subject.runtime_engine, subject.report_id, subject.owner_id)
    assert len(expected.rows) == 3

    completed = execute_due_report_runs(subject.runtime_engine, now=NOW)
    assert len(completed) == 1
    assert execute_due_report_runs(subject.runtime_engine, now=NOW) == []
    with AuditSession(subject.owner_engine) as db:
        work = db.scalar(select(ScheduledWork).where(ScheduledWork.report_id == subject.report_id))
        run = db.get(ReportRun, completed[0])
        rows = list(
            db.scalars(
                select(ReportRunRow)
                .where(ReportRunRow.run_id == completed[0])
                .order_by(ReportRunRow.position)
            )
        )
        assert work is not None and work.state == WorkState.SUCCEEDED
        assert work.run_id == completed[0]
        assert run is not None and run.idempotency_key == work.id
        assert run.csv_bytes == expected.csv_bytes
        assert [(row.record_id, row.cells) for row in rows] == expected.rows
        assert _counts(db, subject.report_id) == (1, 1)


def test_revision_change_after_capture_retries_without_orphan_run(scheduled_report, monkeypatch):
    from app.systems.platform.scheduling import execution

    subject = scheduled_report
    original = execution.capture_report_snapshot

    def mutate_after_capture(engine, report_id, owner_id):
        snapshot = original(engine, report_id, owner_id)
        with AuditSession(subject.owner_engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            report = db.get(Report, report_id)
            assert report is not None
            report.revision += 1
            db.commit()
        return snapshot

    monkeypatch.setattr(execution, "capture_report_snapshot", mutate_after_capture)
    assert execution.execute_due_report_runs(subject.runtime_engine, now=NOW) == []
    with AuditSession(subject.owner_engine) as db:
        work = db.scalar(select(ScheduledWork).where(ScheduledWork.report_id == subject.report_id))
        assert work is not None and work.state == WorkState.PENDING
        assert work.attempt_count == 1 and work.next_attempt_at == NOW + timedelta(seconds=2)
        assert _counts(db, subject.report_id) == (0, 0)


@pytest.mark.parametrize(
    "change",
    ["archive", "source", "permission", "audience_role", "audience_user", "workspace_access"],
)
def test_unavailable_report_after_capture_cancels_without_output(
    scheduled_report, monkeypatch, change
):
    from app.systems.platform.scheduling import execution

    subject = scheduled_report
    original = execution.capture_report_snapshot
    access_rule_id = uuid7()
    outsider_claims = decode_token(subject.outsider_token, TokenType.ACCESS)
    assert outsider_claims is not None
    outsider_id = UUID(str(outsider_claims["sub"]))

    def remove_access_after_capture(engine, report_id, owner_id):
        snapshot = original(engine, report_id, owner_id)
        with AuditSession(subject.owner_engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            if change == "workspace_access":
                db.add(
                    AccessRule(
                        id=access_rule_id,
                        subject_kind="user",
                        subject_id=owner_id,
                        scope_kind="workspace",
                        scope_id=None,
                        permission_id="records.read",
                        decision="deny",
                        policy_version=1,
                    )
                )
            elif change == "archive":
                report = db.get(Report, report_id)
                assert report is not None
                report.is_deleted = True
                report.deleted_at = NOW
            elif change == "source":
                module = db.get(Module, subject.module_id)
                assert module is not None
                module.is_schema_accepted = False
            elif change == "permission":
                user = db.get(User, owner_id)
                assert user is not None
                role = db.get(Role, user.role_id)
                assert role is not None
                role.permissions = {"records.write": True}
            else:
                report = db.get(Report, report_id)
                assert report is not None
                other = db.get(User, outsider_id)
                assert other is not None
                report.audience_kind = "role" if change == "audience_role" else "user"
                report.audience_role_id = other.role_id if change == "audience_role" else None
                report.audience_user_id = other.id if change == "audience_user" else None
            db.commit()
        return snapshot

    monkeypatch.setattr(execution, "capture_report_snapshot", remove_access_after_capture)
    try:
        completed = execution.execute_due_report_runs(subject.runtime_engine, now=NOW)
        with AuditSession(subject.owner_engine) as db:
            work = db.scalar(
                select(ScheduledWork).where(ScheduledWork.report_id == subject.report_id)
            )
            assert work is not None
            if change.startswith("audience_"):
                assert len(completed) == 1
                assert work.state == WorkState.SUCCEEDED
                assert _counts(db, subject.report_id) == (1, 1)
                assert db.get(ReportRunEligibleUser, (completed[0], outsider_id)) is not None
                assert db.get(ReportRunEligibleUser, (completed[0], subject.owner_id)) is None
                notice = db.scalar(
                    select(InAppNotification).where(InAppNotification.work_id == work.id)
                )
                assert notice is not None and notice.recipient_id == outsider_id
            elif change == "workspace_access":
                assert completed == []
                assert work.state == WorkState.PENDING
                assert work.failure_code == "run_failed"
                assert work.attempt_count == 1
                assert _counts(db, subject.report_id) == (0, 0)
            else:
                assert completed == []
                assert work.state == WorkState.CANCELED
                assert work.failure_code == "source_unavailable"
                assert _counts(db, subject.report_id) == (0, 0)
    finally:
        if change == "workspace_access":
            with subject.owner_engine.begin() as cleanup:
                cleanup.execute(
                    text("DELETE FROM public.access_rules WHERE id = :id"),
                    {"id": access_rule_id},
                )


def test_lost_lease_after_capture_cannot_save_or_notify(scheduled_report, monkeypatch):
    from app.systems.platform.scheduling import execution

    subject = scheduled_report
    original = execution.capture_report_snapshot

    def replace_lease_after_capture(engine, report_id, owner_id):
        snapshot = original(engine, report_id, owner_id)
        with AuditSession(subject.owner_engine) as db:
            replacement = claim_due_work(db, now=NOW + timedelta(minutes=3))
            assert len(replacement) == 1
            db.commit()
        return snapshot

    monkeypatch.setattr(execution, "capture_report_snapshot", replace_lease_after_capture)
    assert execution.execute_due_report_runs(subject.runtime_engine, now=NOW) == []
    with AuditSession(subject.owner_engine) as db:
        work = db.scalar(select(ScheduledWork).where(ScheduledWork.report_id == subject.report_id))
        assert work is not None and work.state == WorkState.RUNNING and work.attempt_count == 2
        assert _counts(db, subject.report_id) == (0, 0)


def test_source_purge_after_capture_rolls_back_run_and_retries(scheduled_report, monkeypatch):
    from app.systems.platform.scheduling import execution

    subject = scheduled_report
    original = execution.capture_report_snapshot

    def purge_after_capture(engine, report_id, owner_id):
        snapshot = original(engine, report_id, owner_id)
        with AuditSession(subject.owner_engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            record = db.get(Record, subject.first_record_id)
            assert record is not None
            db.delete(record)
            db.commit()
        return snapshot

    monkeypatch.setattr(execution, "capture_report_snapshot", purge_after_capture)
    assert execution.execute_due_report_runs(subject.runtime_engine, now=NOW) == []
    with AuditSession(subject.owner_engine) as db:
        work = db.scalar(select(ScheduledWork).where(ScheduledWork.report_id == subject.report_id))
        assert work is not None and work.state == WorkState.PENDING
        assert _counts(db, subject.report_id) == (0, 0)


def test_existing_run_key_collision_does_not_notify_unrelated_output(scheduled_report, monkeypatch):
    from app.systems.platform.scheduling import execution

    subject = scheduled_report
    original = execution.capture_report_snapshot

    def collide_after_capture(engine, report_id, owner_id):
        snapshot = original(engine, report_id, owner_id)
        with AuditSession(subject.owner_engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            work = db.scalar(select(ScheduledWork).where(ScheduledWork.report_id == report_id))
            assert work is not None
            db.add(
                ReportRun(
                    report_id=report_id,
                    module_id=subject.module_id,
                    idempotency_key=work.id,
                    recipe_revision=snapshot.recipe_revision,
                    recipe=snapshot.recipe,
                    headings=snapshot.headings,
                    row_count=0,
                    csv_bytes=b"unrelated output",
                )
            )
            db.commit()
        return snapshot

    monkeypatch.setattr(execution, "capture_report_snapshot", collide_after_capture)
    assert execution.execute_due_report_runs(subject.runtime_engine, now=NOW) == []
    with AuditSession(subject.owner_engine) as db:
        work = db.scalar(select(ScheduledWork).where(ScheduledWork.report_id == subject.report_id))
        assert work is not None and work.state == WorkState.PENDING and work.run_id is None
        assert _counts(db, subject.report_id) == (1, 0)


def test_capture_failure_rolls_back_and_retries_once(scheduled_report, monkeypatch):
    from app.systems.platform.scheduling import execution

    subject = scheduled_report
    original = execution.capture_report_snapshot
    attempts = 0

    def fail_once(engine, report_id, owner_id):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("controlled capture failure")
        return original(engine, report_id, owner_id)

    monkeypatch.setattr(execution, "capture_report_snapshot", fail_once)
    assert execution.execute_due_report_runs(subject.runtime_engine, now=NOW) == []
    with AuditSession(subject.owner_engine) as db:
        assert _counts(db, subject.report_id) == (0, 0)
    completed = execution.execute_due_report_runs(
        subject.runtime_engine, now=NOW + timedelta(seconds=2)
    )
    assert len(completed) == 1 and attempts == 2
    with AuditSession(subject.owner_engine) as db:
        assert _counts(db, subject.report_id) == (1, 1)
