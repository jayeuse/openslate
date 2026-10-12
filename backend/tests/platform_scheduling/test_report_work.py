"""Durable Report work and private in-app delivery on runner-owned PostgreSQL."""

import os
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.access.users.models import User, UserStatus
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditLog
from app.systems.openview.reports.models import Report
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
from tests.grant_support import assert_runtime_only_grants
from tests.platform_scheduling.support import report_run, report_work_subject

pytestmark = pytest.mark.integration


def test_persisted_due_occurrence_is_unique_and_stale_lease_cannot_notify(integration_owner_db):
    db = integration_owner_db
    owner, report, _grant, _module, _department = report_work_subject(db)
    now = datetime(2026, 1, 1, tzinfo=UTC)
    work = queue_report_occurrence(db, report.id, scheduled_for=now)
    duplicate = queue_report_occurrence(db, report.id, scheduled_for=now)
    future = queue_report_occurrence(db, report.id, scheduled_for=now + timedelta(days=1))
    assert duplicate.id == work.id

    first = claim_due_work(db, now=now, limit=2)
    assert len(first) == 1 and first[0].id == work.id
    assert work.attempt_count == 1
    assert work.last_attempt_started_at == now
    assert work.finished_at is None
    assert future.state == WorkState.PENDING

    later = now + timedelta(minutes=3)
    second = claim_due_work(db, now=later, limit=2)
    assert len(second) == 1 and second[0].id == work.id
    assert second[0].lease_token != first[0].lease_token
    assert work.last_attempt_started_at == later
    run = report_run(db, report, work)
    assert not complete_report_work(db, first[0], run.id, now=later)
    assert complete_report_work(db, second[0], run.id, now=later)
    assert work.finished_at == later
    assert not complete_report_work(db, second[0], run.id, now=later)

    notifications = list_current_user_notifications(db, owner.id)
    assert len(notifications) == 1
    assert notifications[0].work_id == work.id
    assert notifications[0].recipient_id == owner.id
    assert (notifications[0].kind, notifications[0].subject_type, notifications[0].subject_id) == (
        "report-run",
        "report_run",
        run.id,
    )
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
        "kind": "report-run",
        "subject_type": "report_run",
        "subject_id": str(run.id),
        "recipient_id": str(owner.id),
        "read_at": None,
    }
    savepoint = db.begin_nested()
    db.add(
        InAppNotification(
            work_id=work.id,
            recipient_id=owner.id,
            kind="report-run",
            subject_type="report_run",
            subject_id=run.id,
        )
    )
    with pytest.raises(IntegrityError):
        db.flush()
    savepoint.rollback()
    savepoint = db.begin_nested()
    db.delete(work)
    with pytest.raises(IntegrityError):
        db.flush()
    savepoint.rollback()
    other_role = "member"
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


def test_completion_needs_no_reader_and_a_lost_read_hides_the_notification(
    integration_owner_db,
):
    """The workspace completes the run; the current module read decides who sees it."""

    db = integration_owner_db
    owner, report, grant, _module, _department = report_work_subject(db)
    other = User(
        email=f"report-other-{uuid7().hex}@example.test",
        username=f"report_other_{uuid7().hex[:16]}",
        status=UserStatus.ACTIVE.value,
        role="member",
    )
    db.add(other)
    db.flush()
    now = datetime(2026, 1, 1, tzinfo=UTC)
    work = queue_report_occurrence(db, report.id, scheduled_for=now)
    claim = claim_due_work(db, now=now)[0]
    run = report_run(db, report, work)

    grant.is_deleted = True
    grant.deleted_at = now
    db.flush()
    assert complete_report_work(db, claim, run.id, now=now)
    assert work.state == WorkState.SUCCEEDED
    assert list_current_user_notifications(db, owner.id) == []
    assert list_current_user_notifications(db, other.id) == []
    grant.is_deleted = False
    grant.deleted_at = None
    db.flush()
    assert len(list_current_user_notifications(db, owner.id)) == 1


def test_report_occurrence_queues_while_nobody_can_read_the_module(integration_owner_db):
    db = integration_owner_db
    _owner, report, grant, _module, _department = report_work_subject(db)
    grant.is_deleted = True
    grant.deleted_at = datetime(2026, 1, 1, tzinfo=UTC)
    db.flush()

    work = queue_report_occurrence(db, report.id, scheduled_for=datetime(2026, 1, 1, tzinfo=UTC))

    assert db.scalar(select(ScheduledWork).where(ScheduledWork.report_id == report.id)) == work


def test_report_occurrence_refuses_an_archived_report_or_a_closed_module(integration_owner_db):
    db = integration_owner_db
    _owner, report, _grant, module, _department = report_work_subject(db)
    now = datetime(2026, 1, 1, tzinfo=UTC)
    module.is_deleted = True
    module.deleted_at = now
    db.flush()
    with pytest.raises(ValueError, match="Report is unavailable for scheduling"):
        queue_report_occurrence(db, report.id, scheduled_for=now)
    module.is_deleted = False
    module.deleted_at = None
    report.is_deleted = True
    report.deleted_at = now
    db.flush()
    with pytest.raises(ValueError, match="Report is unavailable for scheduling"):
        queue_report_occurrence(db, report.id, scheduled_for=now)


def test_failed_work_retries_with_backoff_then_stops_after_five_attempts(integration_owner_db):
    db = integration_owner_db
    owner, report, _grant, _module, _department = report_work_subject(db)
    now = datetime(2026, 1, 1, tzinfo=UTC)
    work = queue_report_occurrence(db, report.id, scheduled_for=now)
    for attempt in range(1, 6):
        claim = claim_due_work(db, now=now)
        assert len(claim) == 1 and claim[0].id == work.id
        assert work.last_attempt_started_at == now
        assert fail_report_work(db, claim[0], now=now)
        assert not fail_report_work(db, claim[0], now=now)
        if attempt < 5:
            db.flush()
            assert (
                list(
                    db.scalars(
                        select(InAppNotification).where(InAppNotification.work_id == work.id)
                    )
                )
                == []
            )
            assert work.state == WorkState.PENDING
            assert work.finished_at is None
            assert claim_due_work(db, now=now) == []
            now += timedelta(seconds=2**attempt)
        else:
            assert work.state == WorkState.FAILED
            assert work.finished_at == now
            assert claim_due_work(db, now=now + timedelta(days=1)) == []
    db.commit()
    notices = list(
        db.scalars(select(InAppNotification).where(InAppNotification.work_id == work.id))
    )
    assert len(notices) == 1
    assert (
        notices[0].kind,
        notices[0].subject_type,
        notices[0].subject_id,
        notices[0].recipient_id,
    ) == ("report-run-failed", "scheduled_work", work.id, owner.id)
    assert list_current_user_notifications(db, owner.id) == notices


@pytest.mark.parametrize("rollback", [False, True])
def test_expired_final_report_lease_notifies_once_or_rolls_back_with_state(
    integration_owner_db, rollback
):
    db = integration_owner_db
    owner, report, grant, _module, _department = report_work_subject(db)
    now = datetime(2026, 1, 1, tzinfo=UTC)
    work = queue_report_occurrence(db, report.id, scheduled_for=now)
    work.state = WorkState.RUNNING
    work.attempt_count = 5
    work.lease_token = uuid7()
    work.lease_expires_at = now - timedelta(seconds=1)
    prior_start = now - timedelta(minutes=3)
    work.last_attempt_started_at = prior_start
    db.commit()
    assert claim_due_work(db, now=now) == []
    db.flush()
    notices = list(
        db.scalars(select(InAppNotification).where(InAppNotification.work_id == work.id))
    )
    assert len(notices) == 1
    assert notices[0].recipient_id == owner.id
    assert work.state == WorkState.FAILED
    assert work.finished_at == now and work.last_attempt_started_at == prior_start
    if rollback:
        db.rollback()
        db.expire_all()
        assert work.state == WorkState.RUNNING
        assert work.finished_at is None
        assert (
            list(db.scalars(select(InAppNotification).where(InAppNotification.work_id == work.id)))
            == []
        )
    else:
        db.commit()
        assert claim_due_work(db, now=now + timedelta(days=1)) == []
        assert list_current_user_notifications(db, owner.id) == notices
        grant.is_deleted = True
        db.commit()
        assert list_current_user_notifications(db, owner.id) == []


def test_concurrent_claim_skips_locked_due_row_and_claims_next():
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    now = datetime(2026, 1, 1, tzinfo=UTC)
    ids: dict[str, UUID] = {}
    try:
        with AuditSession(engine) as setup:
            setup.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            owner, report, grant, module, department = report_work_subject(setup)
            ids.update(
                owner=owner.id,
                report=report.id,
                grant=grant.id,
                group=grant.group_id,
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
                    ("grant", GroupAccess),
                    ("module", Module),
                    ("department", Department),
                ):
                    if key in ids and (row := cleanup.get(model, ids[key])) is not None:
                        cleanup.delete(row)
                        cleanup.flush()
                for membership in cleanup.scalars(
                    select(GroupMember).where(GroupMember.group_id == ids["group"])
                ):
                    cleanup.delete(membership)
                cleanup.flush()
                for key, model in (("group", Group), ("owner", User)):
                    if key in ids and (row := cleanup.get(model, ids[key])) is not None:
                        cleanup.delete(row)
                        cleanup.flush()
                cleanup.commit()
        engine.dispose()


def test_scheduling_tables_grant_runtime_access_and_block_provider_roles(integration_owner_db):
    connection = integration_owner_db.connection()
    for table_name in ("public.scheduled_work", "public.in_app_notifications"):
        assert_runtime_only_grants(connection, table_name)
