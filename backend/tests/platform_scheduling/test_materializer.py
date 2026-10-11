"""Report schedule wall-clock and durable materialization behavior."""

import os
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, time
from uuid import UUID

import pytest
from sqlalchemy import select, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.access.users.models import User, UserStatus
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.openview.reports.models import Report
from app.systems.openview.reports.schedule_models import ReportSchedule
from app.systems.platform.scheduling.materializer import materialize_due_schedules, next_due_after
from app.systems.platform.scheduling.models import ScheduledWork
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from tests.conftest import guarded_create_engine


def test_daily_spring_gap_shifts_forward_then_resumes_local_time():
    policy = {
        "cadence": "daily",
        "timezone_name": "America/New_York",
        "local_time": time(2, 30),
        "weekday": None,
        "month_day": None,
    }
    spring = next_due_after(after=datetime(2026, 3, 7, 7, 30, tzinfo=UTC), **policy)
    assert spring == datetime(2026, 3, 8, 7, 30, tzinfo=UTC)
    assert next_due_after(after=spring, **policy) == datetime(2026, 3, 9, 6, 30, tzinfo=UTC)


def test_daily_fall_fold_uses_earlier_offset_only_once():
    policy = {
        "cadence": "daily",
        "timezone_name": "America/New_York",
        "local_time": time(1, 30),
        "weekday": None,
        "month_day": None,
    }
    first = next_due_after(after=datetime(2026, 10, 31, 5, 30, tzinfo=UTC), **policy)
    assert first == datetime(2026, 11, 1, 5, 30, tzinfo=UTC)
    assert next_due_after(after=first, **policy) == datetime(2026, 11, 2, 6, 30, tzinfo=UTC)


def test_weekly_anchor_and_monthly_absent_dates_skip():
    assert next_due_after(
        cadence="weekly",
        timezone_name="Asia/Manila",
        local_time=time(9, 15),
        weekday=0,
        month_day=None,
        after=datetime(2026, 2, 1, 0, 0, tzinfo=UTC),
    ) == datetime(2026, 2, 2, 1, 15, tzinfo=UTC)
    assert next_due_after(
        cadence="monthly",
        timezone_name="UTC",
        local_time=time(9),
        weekday=None,
        month_day=31,
        after=datetime(2026, 1, 31, 9, tzinfo=UTC),
    ) == datetime(2026, 3, 31, 9, tzinfo=UTC)


def test_unknown_timezone_and_non_utc_instant_fail_closed():
    with pytest.raises(ValueError, match="Schedule requires an IANA timezone"):
        next_due_after(
            cadence="daily",
            timezone_name="No/Such_Zone",
            local_time=time(9),
            weekday=None,
            month_day=None,
            after=datetime(2026, 1, 1, tzinfo=UTC),
        )
    with pytest.raises(ValueError, match="Schedule cursor requires a UTC instant"):
        next_due_after(
            cadence="daily",
            timezone_name="UTC",
            local_time=time(9),
            weekday=None,
            month_day=None,
            after=datetime(2026, 1, 1),
        )


def _subject(
    db: AuditSession, due: datetime
) -> tuple[User, Report, ReportSchedule, str, Module, Department]:
    # The materializer concerns scheduling; an administrator can always run the report.
    role = "admin"
    owner = User(
        email=f"materializer-{uuid7().hex}@example.test",
        username=f"materializer_{uuid7().hex[:16]}",
        status=UserStatus.ACTIVE.value,
        role=role,
    )
    department = Department(department_name=f"Materializer {uuid7().hex}")
    db.add_all((owner, department))
    db.flush()
    module = Module(
        department_id=department.id,
        module_name=f"Materializer {uuid7().hex}",
    )
    db.add(module)
    db.flush()
    report = Report(module_id=module.id, name="Scheduled", recipe={})
    db.add(report)
    db.flush()
    schedule = ReportSchedule(
        report_id=report.id,
        enabled=True,
        cadence="daily",
        timezone_name="UTC",
        local_time=time(9),
        weekday=None,
        month_day=None,
        next_due_at=due,
    )
    db.add(schedule)
    db.flush()
    return owner, report, schedule, role, module, department


@contextmanager
def _committed_subject(due: datetime) -> Iterator[tuple[Engine, dict[str, UUID]]]:
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    ids: dict[str, UUID] = {}
    try:
        with AuditSession(engine) as setup:
            setup.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            owner, report, schedule, role, module, department = _subject(setup, due)
            ids = {
                "owner": owner.id,
                "report": report.id,
                "schedule": schedule.id,
                "module": module.id,
                "department": department.id,
            }
            setup.commit()
        yield engine, ids
    finally:
        if ids:
            with AuditSession(engine) as cleanup:
                cleanup.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
                for work in cleanup.scalars(
                    select(ScheduledWork).where(ScheduledWork.report_id == ids["report"])
                ):
                    cleanup.delete(work)
                cleanup.flush()
                for key, model in (
                    ("schedule", ReportSchedule),
                    ("report", Report),
                    ("module", Module),
                    ("department", Department),
                    ("owner", User),
                ):
                    if (row := cleanup.get(model, ids[key])) is not None:
                        cleanup.delete(row)
                        cleanup.flush()
                cleanup.commit()
        engine.dispose()


@pytest.mark.integration
def test_missed_dates_materialize_once_across_sessions_and_advance_cursor():
    first_due = datetime(2026, 1, 1, 9, tzinfo=UTC)
    with _committed_subject(first_due) as (engine, ids):
        for day in range(1, 4):
            with AuditSession(engine) as db:
                db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
                work_ids = materialize_due_schedules(
                    db, now=datetime(2026, 1, 3, 9, tzinfo=UTC), limit=1
                )
                assert len(work_ids) == 1
                work = db.get(ScheduledWork, work_ids[0])
                assert work is not None
                assert work.scheduled_for == datetime(2026, 1, day, 9, tzinfo=UTC)
                db.commit()
        with AuditSession(engine) as db:
            assert materialize_due_schedules(db, now=datetime(2026, 1, 3, 9, tzinfo=UTC)) == []
            schedule = db.get(ReportSchedule, ids["schedule"])
            assert schedule is not None
            assert schedule.next_due_at == datetime(2026, 1, 4, 9, tzinfo=UTC)
            works = list(
                db.scalars(select(ScheduledWork).where(ScheduledWork.report_id == ids["report"]))
            )
            assert len(works) == len({work.scheduled_for for work in works}) == 3


@pytest.mark.integration
def test_concurrent_materializers_skip_locked_report_and_do_not_duplicate_work():
    due = datetime(2026, 1, 1, 9, tzinfo=UTC)
    with _committed_subject(due) as (engine, ids):
        with AuditSession(engine) as first, AuditSession(engine) as second:
            first.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            second.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            assert len(materialize_due_schedules(first, now=due)) == 1
            assert materialize_due_schedules(second, now=due) == []
            first.commit()
            second.rollback()
        with AuditSession(engine) as db:
            assert materialize_due_schedules(db, now=due) == []
            assert (
                len(
                    list(
                        db.scalars(
                            select(ScheduledWork).where(ScheduledWork.report_id == ids["report"])
                        )
                    )
                )
                == 1
            )


@pytest.mark.integration
def test_enqueue_and_cursor_advance_roll_back_together():
    due = datetime(2026, 1, 1, 9, tzinfo=UTC)
    with _committed_subject(due) as (engine, ids):
        with AuditSession(engine) as first:
            first.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            assert len(materialize_due_schedules(first, now=due)) == 1
            first.rollback()
        with AuditSession(engine) as retry:
            retry.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            schedule = retry.get(ReportSchedule, ids["schedule"])
            assert schedule is not None and schedule.next_due_at == due
            assert (
                retry.scalar(select(ScheduledWork).where(ScheduledWork.report_id == ids["report"]))
                is None
            )
            assert len(materialize_due_schedules(retry, now=due)) == 1
            retry.commit()


@pytest.mark.integration
def test_schedule_edits_replace_due_cursor_and_one_policy_is_enforced(integration_owner_db):
    db = integration_owner_db
    old_due = datetime(2026, 1, 1, 9, tzinfo=UTC)
    _owner, report, schedule, _role, _module, _department = _subject(db, old_due)
    savepoint = db.begin_nested()
    db.add(
        ReportSchedule(
            report_id=report.id,
            enabled=False,
            cadence="daily",
            timezone_name="UTC",
            local_time=time(9),
            next_due_at=old_due,
        )
    )
    with pytest.raises(IntegrityError):
        db.flush()
    savepoint.rollback()
    schedule.cadence = "weekly"
    schedule.weekday = 0
    schedule.next_due_at = next_due_after(
        cadence="weekly",
        timezone_name="UTC",
        local_time=time(9),
        weekday=0,
        month_day=None,
        after=old_due,
    )
    schedule.revision += 1
    db.flush()
    assert materialize_due_schedules(db, now=old_due) == []
    assert len(materialize_due_schedules(db, now=schedule.next_due_at)) == 1
    assert schedule.revision == 2


@pytest.mark.integration
@pytest.mark.parametrize("unavailable", ["archived", "closed_module"])
def test_unavailable_report_or_source_disables_policy_without_enqueuing(
    integration_owner_db, unavailable
):
    db = integration_owner_db
    due = datetime(2026, 1, 1, 9, tzinfo=UTC)
    _owner, report, schedule, _role, module, _department = _subject(db, due)
    if unavailable == "archived":
        report.is_deleted = True
        report.deleted_at = due
    else:
        module.is_deleted = True
        module.deleted_at = due
    db.flush()
    assert materialize_due_schedules(db, now=due) == []
    assert schedule.enabled is False
    assert schedule.next_due_at == due
    assert db.scalar(select(ScheduledWork).where(ScheduledWork.report_id == report.id)) is None


@pytest.mark.integration
def test_report_schedule_table_grants_runtime_access_and_blocks_provider_roles(
    integration_owner_db,
):
    connection = integration_owner_db.connection()
    statement = text("SELECT has_table_privilege(:role, 'public.report_schedules', :privilege)")
    for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
        assert connection.scalar(
            statement,
            {"role": "openslate_runtime", "privilege": privilege},
        ) is True
        for role in ("anon", "authenticated", "service_role"):
            assert (
                connection.scalar(
                    statement,
                    {"role": role, "privilege": privilege},
                )
                is False
            )


@pytest.mark.integration
def test_disabled_schedule_editor_does_not_stop_materialization(integration_owner_db):
    """A scheduled Report runs as the workspace, so no user account can stop it."""

    db = integration_owner_db
    due = datetime(2026, 1, 1, 9, tzinfo=UTC)
    owner, report, schedule, _role, _module, _department = _subject(db, due)
    owner.status = UserStatus.DISABLED.value
    db.flush()

    assert len(materialize_due_schedules(db, now=due)) == 1
    assert schedule.enabled is True
    assert db.scalar(select(ScheduledWork).where(ScheduledWork.report_id == report.id))
