"""Durable Report work and private in-app delivery on runner-owned PostgreSQL."""

import os
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditLog
from app.systems.openview.reports.audience import capture_run_eligible_users
from app.systems.openview.reports.models import Report, ReportRun
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork, WorkState
from app.systems.platform.scheduling.service import (
    claim_due_work,
    complete_report_work,
    fail_report_work,
    list_current_user_notifications,
    queue_report_occurrence,
)
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from tests.conftest import guarded_create_engine

pytestmark = pytest.mark.integration


def _subject(db: AuditSession) -> tuple[User, Report, Role, Module, Department]:
    role = Role(
        role=f"report-schedule-{uuid7().hex}",
        permissions={"records.read": True, "records.write": True},
    )
    owner = User(
        email=f"report-schedule-{uuid7().hex}@example.test",
        username=f"report_schedule_{uuid7().hex[:16]}",
        status=UserStatus.ACTIVE.value,
        role=role,
    )
    department = Department(department_name=f"Report schedule {uuid7().hex}")
    db.add_all((owner, department))
    db.flush()
    module = Module(
        department_id=department.id,
        module_name=f"Report schedule {uuid7().hex}",
        is_schema_accepted=True,
    )
    db.add(module)
    db.flush()
    report = Report(owner_id=owner.id, module_id=module.id, name="Scheduled", recipe={})
    db.add(report)
    db.flush()
    return owner, report, role, module, department


def _run(db: AuditSession, report: Report, work: ScheduledWork) -> ReportRun:
    run = ReportRun(
        report_id=report.id,
        module_id=report.module_id,
        idempotency_key=work.id,
        recipe_revision=report.revision,
        recipe={},
        headings=[],
        row_count=0,
        csv_bytes=b"",
    )
    db.add(run)
    db.flush()
    capture_run_eligible_users(db, report, run.id)
    return run


def test_persisted_due_occurrence_is_unique_and_stale_lease_cannot_notify(integration_owner_db):
    db = integration_owner_db
    owner, report, _role, _module, _department = _subject(db)
    now = datetime(2026, 1, 1, tzinfo=UTC)
    work = queue_report_occurrence(db, report.id, scheduled_for=now)
    duplicate = queue_report_occurrence(db, report.id, scheduled_for=now)
    future = queue_report_occurrence(db, report.id, scheduled_for=now + timedelta(days=1))
    assert duplicate.id == work.id

    first = claim_due_work(db, now=now, limit=2)
    assert len(first) == 1 and first[0].id == work.id
    assert work.attempt_count == 1
    assert future.state == WorkState.PENDING

    later = now + timedelta(minutes=3)
    second = claim_due_work(db, now=later, limit=2)
    assert len(second) == 1 and second[0].id == work.id
    assert second[0].lease_token != first[0].lease_token
    run = _run(db, report, work)
    assert not complete_report_work(db, first[0], run.id, now=later)
    assert complete_report_work(db, second[0], run.id, now=later)
    assert not complete_report_work(db, second[0], run.id, now=later)

    notifications = list_current_user_notifications(db, owner.id)
    assert len(notifications) == 1
    assert notifications[0].work_id == work.id
    assert notifications[0].recipient_id == owner.id
    audit = db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == "in_app_notifications",
            AuditLog.entity_id == notifications[0].id,
        )
    )
    assert audit is not None
    assert audit.performed_by is None
    assert audit.after == {
        "work_id": str(work.id),
        "recipient_id": str(owner.id),
        "read_at": None,
    }
    with pytest.raises(IntegrityError), db.begin_nested():
        db.add(InAppNotification(work_id=work.id, recipient_id=owner.id))
        db.flush()
    with pytest.raises(IntegrityError), db.begin_nested():
        db.delete(work)
        db.flush()
    other_role = Role(role=f"report-other-{uuid7().hex}", permissions={"records.read": True})
    other = User(
        email=f"report-other-{uuid7().hex}@example.test",
        username=f"report_other_{uuid7().hex[:16]}",
        status=UserStatus.ACTIVE.value,
        role=other_role,
    )
    db.add(other)
    db.flush()
    assert list_current_user_notifications(db, other.id) == []
    assert (
        db.scalar(select(InAppNotification).where(InAppNotification.work_id == future.id)) is None
    )


def test_completion_rechecks_owner_capability_and_current_user_read_is_private(
    integration_owner_db,
):
    db = integration_owner_db
    owner, report, role, _module, _department = _subject(db)
    other_role = Role(role=f"report-other-{uuid7().hex}", permissions={"records.read": True})
    other = User(
        email=f"report-other-{uuid7().hex}@example.test",
        username=f"report_other_{uuid7().hex[:16]}",
        status=UserStatus.ACTIVE.value,
        role=other_role,
    )
    db.add(other)
    db.flush()
    now = datetime(2026, 1, 1, tzinfo=UTC)
    work = queue_report_occurrence(db, report.id, scheduled_for=now)
    claim = claim_due_work(db, now=now)[0]
    run = _run(db, report, work)
    assert list_current_user_notifications(db, other.id) == []

    role.permissions = {"records.write": True}
    assert not complete_report_work(db, claim, run.id, now=now)
    assert work.state == WorkState.CANCELED
    assert list_current_user_notifications(db, owner.id) == []


@pytest.mark.parametrize("audience_kind", ["role", "user"])
def test_owner_excluded_by_current_report_audience_can_queue_work_for_readers(
    integration_owner_db, audience_kind
):
    db = integration_owner_db
    owner, report, _role, _module, _department = _subject(db)
    other_role = Role(
        role=f"report-audience-{uuid7().hex}",
        permissions={"records.read": True, "records.write": True},
    )
    other = User(
        email=f"report-audience-{uuid7().hex}@example.test",
        username=f"report_audience_{uuid7().hex[:16]}",
        status=UserStatus.ACTIVE.value,
        role=other_role,
    )
    db.add(other)
    db.flush()
    report.audience_kind = audience_kind
    report.audience_role_id = other_role.id if audience_kind == "role" else None
    report.audience_user_id = other.id if audience_kind == "user" else None

    work = queue_report_occurrence(db, report.id, scheduled_for=datetime(2026, 1, 1, tzinfo=UTC))
    assert db.scalar(select(ScheduledWork).where(ScheduledWork.report_id == report.id)) == work
    assert list_current_user_notifications(db, owner.id) == []


def test_notification_visibility_follows_current_report_audience_and_owner_role(
    integration_owner_db,
):
    db = integration_owner_db
    owner, report, role, _module, _department = _subject(db)
    other_role = Role(
        role=f"report-audience-{uuid7().hex}",
        permissions={"records.read": True, "records.write": True},
    )
    other = User(
        email=f"report-audience-{uuid7().hex}@example.test",
        username=f"report_audience_{uuid7().hex[:16]}",
        status=UserStatus.ACTIVE.value,
        role=other_role,
    )
    db.add(other)
    db.flush()
    now = datetime(2026, 1, 1, tzinfo=UTC)
    work = queue_report_occurrence(db, report.id, scheduled_for=now)
    claim = claim_due_work(db, now=now)[0]
    run = _run(db, report, work)
    assert complete_report_work(db, claim, run.id, now=now)
    assert len(list_current_user_notifications(db, owner.id)) == 1

    report.audience_kind = "role"
    report.audience_role_id = role.id
    assert len(list_current_user_notifications(db, owner.id)) == 1
    owner.role_id = other_role.id
    assert list_current_user_notifications(db, owner.id) == []
    report.audience_role_id = other_role.id
    assert len(list_current_user_notifications(db, owner.id)) == 1

    report.audience_kind = "user"
    report.audience_role_id = None
    report.audience_user_id = other.id
    assert list_current_user_notifications(db, owner.id) == []
    assert list_current_user_notifications(db, other.id) == []
    report.audience_user_id = owner.id
    assert len(list_current_user_notifications(db, owner.id)) == 1


def test_failed_work_retries_with_backoff_then_stops_after_five_attempts(integration_owner_db):
    db = integration_owner_db
    _owner, report, _role, _module, _department = _subject(db)
    now = datetime(2026, 1, 1, tzinfo=UTC)
    work = queue_report_occurrence(db, report.id, scheduled_for=now)
    for attempt in range(1, 6):
        claim = claim_due_work(db, now=now)
        assert len(claim) == 1 and claim[0].id == work.id
        assert fail_report_work(db, claim[0], now=now)
        assert not fail_report_work(db, claim[0], now=now)
        if attempt < 5:
            assert work.state == WorkState.PENDING
            assert claim_due_work(db, now=now) == []
            now += timedelta(seconds=2**attempt)
        else:
            assert work.state == WorkState.FAILED
            assert claim_due_work(db, now=now + timedelta(days=1)) == []


def test_concurrent_claim_skips_locked_due_row_and_claims_next():
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    now = datetime(2026, 1, 1, tzinfo=UTC)
    ids: dict[str, UUID] = {}
    try:
        with AuditSession(engine) as setup:
            setup.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            owner, report, role, module, department = _subject(setup)
            ids.update(
                owner=owner.id,
                report=report.id,
                role=role.id,
                module=module.id,
                department=department.id,
            )
            first = queue_report_occurrence(setup, report.id, scheduled_for=now)
            second = queue_report_occurrence(
                setup, report.id, scheduled_for=now + timedelta(seconds=1)
            )
            ids.update(first=first.id, second=second.id)
            setup.commit()

        with AuditSession(engine) as first_db, AuditSession(engine) as second_db:
            first_claim = claim_due_work(first_db, now=now + timedelta(seconds=1), limit=1)
            assert len(first_claim) == 1 and first_claim[0].id == ids["first"]
            second_claim = claim_due_work(second_db, now=now + timedelta(seconds=1), limit=1)
            assert len(second_claim) == 1 and second_claim[0].id == ids["second"]
            second_db.commit()
            first_db.commit()
    finally:
        if ids:
            with AuditSession(engine) as cleanup:
                cleanup.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
                for key, model in (
                    ("first", ScheduledWork),
                    ("second", ScheduledWork),
                    ("report", Report),
                    ("module", Module),
                    ("department", Department),
                    ("owner", User),
                    ("role", Role),
                ):
                    if key in ids and (row := cleanup.get(model, ids[key])) is not None:
                        cleanup.delete(row)
                        cleanup.flush()
                cleanup.commit()
        engine.dispose()


def test_scheduling_tables_grant_runtime_access_and_block_provider_roles(integration_owner_db):
    connection = integration_owner_db.connection()
    statement = text("SELECT has_table_privilege(:role, :table_name, :privilege)")
    for table_name in ("public.scheduled_work", "public.in_app_notifications"):
        for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
            assert connection.scalar(
                statement,
                {"role": "openslate_runtime", "table_name": table_name, "privilege": privilege},
            ) is True
            for role in ("anon", "authenticated", "service_role"):
                assert (
                    connection.scalar(
                        statement,
                        {"role": role, "table_name": table_name, "privilege": privilege},
                    )
                    is False
                )
