"""Revisioned Report schedule routes against runner-owned PostgreSQL."""

import os
from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event
from typing import Annotated
from uuid import UUID

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext, set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.openview.reports import schedule_router
from app.systems.openview.reports.deletion_service import delete_report_tree
from app.systems.openview.reports.models import Report, ReportRun
from app.systems.openview.reports.schedule_models import ReportSchedule
from app.systems.openview.reports.schedule_router import router
from app.systems.platform.scheduling.models import ScheduledWork, WorkState
from app.systems.platform.scheduling.service import WorkClaim, complete_report_work
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from tests.conftest import guarded_create_engine

pytestmark = pytest.mark.integration


def _actor(db: Session, permissions: dict[str, bool]) -> User:
    role = Role(role=f"schedule-{uuid7().hex}", permissions=permissions)
    user_id = uuid7()
    user = User(
        id=user_id,
        email=f"schedule-{user_id.hex}@example.test",
        username=f"schedule_{user_id.hex[:16]}",
        status=UserStatus.ACTIVE.value,
        role=role,
    )
    db.add(user)
    db.flush()
    return user


def _report(db: Session, owner: User) -> tuple[Report, Module]:
    department = Department(department_name=f"Schedule {uuid7().hex}")
    db.add(department)
    db.flush()
    module = Module(
        department_id=department.id,
        module_name=f"Schedule {uuid7().hex}",
        is_schema_accepted=True,
    )
    db.add(module)
    db.flush()
    field = Field(
        module_id=module.id,
        name="Status",
        type=FieldType.TEXT,
        required=False,
        position=0,
        config={},
    )
    db.add(field)
    db.flush()
    report = Report(
        owner_id=owner.id,
        module_id=module.id,
        name="Scheduled status",
        recipe={
            "version": 1,
            "fields": [{"field_id": str(field.id), "expected_type": "text"}],
            "filters": [],
            "logic": "and",
            "sorts": [],
            "group_by": None,
            "include_row_count": False,
        },
    )
    db.add(report)
    db.flush()
    return report, module


def _client(db: Session, user: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def _daily(*, enabled: bool = True) -> dict[str, object]:
    return {
        "enabled": enabled,
        "cadence": "daily",
        "timezone_name": "America/New_York",
        "local_time": "02:30",
    }


def test_create_read_revision_and_strict_contract(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    owner = _actor(db, {"records.read": True, "records.write": True})
    report, _module = _report(db, owner)
    set_audit_actor(db, owner.id)
    clock = datetime(2026, 3, 7, 7, 30, tzinfo=UTC)
    monkeypatch.setattr(
        "app.systems.openview.reports.schedule_router.utc_now", lambda: clock
    )
    path = f"/api/reports/{report.id}/schedule"
    with _client(db, owner) as client:
        created = client.post(path, json=_daily())
        assert created.status_code == 201, created.text
        assert created.headers["location"] == path
        assert created.headers["cache-control"] == "private, no-store"
        body = created.json()
        assert body["report_id"] == str(report.id)
        assert body["revision"] == 1
        assert body["local_time"] == "02:30"
        assert body["next_due_at"] == "2026-03-08T07:30:00Z"
        assert client.get(path).json() == body
        assert client.post(path, json=_daily()).json()["detail"]["code"] == "schedule_exists"
        assert (
            client.post(path, json={**_daily(), "next_due_at": clock.isoformat()}).status_code
            == 422
        )
        assert (
            client.post(path, json={**_daily(), "timezone_name": "No/Such_Zone"}).status_code
            == 422
        )
        assert client.post(path, json={**_daily(), "local_time": "02:30:00"}).status_code == 422
    policy = db.scalar(select(ReportSchedule).where(ReportSchedule.report_id == report.id))
    assert policy is not None and policy.next_due_at == datetime(2026, 3, 8, 7, 30, tzinfo=UTC)
    audit = db.scalars(
        select(AuditLog).where(
            AuditLog.entity_type == "report_schedules", AuditLog.entity_id == policy.id
        )
    ).all()
    assert [entry.action for entry in audit] == [AuditAction.CREATE]


def test_owner_excluded_can_enable_schedule_for_eligible_readers(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    owner = _actor(db, {"records.read": True, "records.write": True})
    other = _actor(db, {"records.read": True, "records.write": True})
    report, _module = _report(db, owner)
    report.audience_kind = "user"
    report.audience_user_id = other.id
    db.flush()
    set_audit_actor(db, owner.id)
    monkeypatch.setattr(
        "app.systems.openview.reports.schedule_router.utc_now",
        lambda: datetime(2026, 1, 1, tzinfo=UTC),
    )
    path = f"/api/reports/{report.id}/schedule"
    with _client(db, owner) as client:
        created = client.post(path, json=_daily(enabled=False))
        assert created.status_code == 201, created.text
        assert created.json()["next_due_at"] is None
        assert client.get(path).json()["enabled"] is False
        enabled = client.patch(path, json={"revision": 1, "enabled": True})
        assert enabled.status_code == 200, enabled.text
        assert enabled.json()["enabled"] is True
        assert enabled.json()["next_due_at"] == "2026-01-01T07:30:00Z"
        assert client.patch(path, json={"revision": 2, "local_time": "10:15"}).status_code == 200
    policy = db.scalar(select(ReportSchedule).where(ReportSchedule.report_id == report.id))
    assert policy is not None and policy.enabled and policy.revision == 3
    assert policy.next_due_at == datetime(2026, 1, 1, 15, 15, tzinfo=UTC)
    report.audience_kind = "private"
    report.audience_user_id = None
    db.flush()
    monkeypatch.setattr(
        "app.systems.openview.reports.schedule_router.utc_now",
        lambda: datetime(2026, 1, 3, 16, tzinfo=UTC),
    )
    with _client(db, owner) as client:
        disabled = client.patch(path, json={"revision": 3, "enabled": False})
        assert disabled.status_code == 200, disabled.text
        enabled = client.patch(path, json={"revision": 4, "enabled": True})
        assert enabled.status_code == 200, enabled.text
        assert enabled.json()["next_due_at"] == "2026-01-04T15:15:00Z"
    db.refresh(policy)
    assert policy.enabled and policy.revision == 5


def test_edit_cancels_pending_and_running_work_and_rejects_stale_revision(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    owner = _actor(db, {"records.read": True, "records.write": True})
    report, _module = _report(db, owner)
    set_audit_actor(db, owner.id)
    now = datetime(2026, 1, 1, 12, tzinfo=UTC)
    monkeypatch.setattr("app.systems.openview.reports.schedule_router.utc_now", lambda: now)
    path = f"/api/reports/{report.id}/schedule"
    with _client(db, owner) as client:
        assert client.post(path, json={**_daily(), "timezone_name": "UTC"}).status_code == 201
    pending = ScheduledWork(
        report_id=report.id,
        scheduled_for=now - timedelta(days=1),
        next_attempt_at=now - timedelta(days=1),
    )
    running = ScheduledWork(
        report_id=report.id,
        scheduled_for=now - timedelta(days=2),
        next_attempt_at=now - timedelta(days=2),
        state=WorkState.RUNNING,
        lease_token=uuid7(),
        lease_expires_at=now + timedelta(minutes=2),
    )
    completed_run = ReportRun(
        report_id=report.id,
        module_id=report.module_id,
        idempotency_key=uuid7(),
        recipe_revision=report.revision,
        recipe=report.recipe,
        headings=["Status"],
        row_count=0,
        csv_bytes=b"Status\r\n",
    )
    db.add(completed_run)
    db.flush()
    completed = ScheduledWork(
        report_id=report.id,
        scheduled_for=now - timedelta(days=3),
        next_attempt_at=now - timedelta(days=3),
        state=WorkState.SUCCEEDED,
        run_id=completed_run.id,
    )
    db.add_all([pending, running, completed])
    db.commit()
    former_lease = running.lease_token
    assert former_lease is not None
    with _client(db, owner) as client:
        stale = client.patch(path, json={"revision": 2, "enabled": False})
        assert stale.status_code == 409
        assert stale.json()["detail"]["code"] == "stale_revision"
        disabled = client.patch(path, json={"revision": 1, "enabled": False})
        assert disabled.status_code == 200, disabled.text
        assert disabled.json()["revision"] == 2
        assert disabled.json()["next_due_at"] is None
    db.refresh(pending)
    db.refresh(running)
    assert pending.state == running.state == WorkState.CANCELED
    assert pending.lease_token is None and running.lease_token is None
    assert pending.lease_expires_at is None and running.lease_expires_at is None
    assert not complete_report_work(db, WorkClaim(running.id, former_lease), uuid7(), now=now)
    db.refresh(completed)
    assert completed.state == WorkState.SUCCEEDED and completed.run_id == completed_run.id
    policy = db.scalar(select(ReportSchedule).where(ReportSchedule.report_id == report.id))
    assert policy is not None and policy.revision == 2
    audit = db.scalars(
        select(AuditLog).where(
            AuditLog.entity_type == "report_schedules", AuditLog.entity_id == policy.id
        ).order_by(AuditLog.created_at, AuditLog.id)
    ).all()
    assert [entry.action for entry in audit] == [AuditAction.CREATE, AuditAction.UPDATE]


def test_schedule_owner_capability_source_and_archive_boundaries(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    owner = _actor(db, {"records.read": True, "records.write": True})
    outsider = _actor(db, {"records.read": True, "records.write": True})
    read_only = _actor(db, {"records.read": True})
    report, module = _report(db, owner)
    set_audit_actor(db, owner.id)
    monkeypatch.setattr(
        "app.systems.openview.reports.schedule_router.utc_now",
        lambda: datetime(2026, 1, 1, tzinfo=UTC),
    )
    path = f"/api/reports/{report.id}/schedule"
    with _client(db, outsider) as client:
        assert client.get(path).status_code == 404
        assert client.post(path, json=_daily()).status_code == 404
    with _client(db, read_only) as client:
        assert client.post(path, json=_daily()).status_code == 403
    module.is_schema_accepted = False
    db.flush()
    with _client(db, owner) as client:
        assert client.post(path, json=_daily()).json()["detail"]["code"] == "schedule_ineligible"
        assert client.post(path, json=_daily(enabled=False)).status_code == 201
    report.is_deleted = True
    report.deleted_at = datetime(2026, 1, 1, tzinfo=UTC)
    db.flush()
    with _client(db, owner) as client:
        assert client.get(path).status_code == 409
        assert client.patch(path, json={"revision": 1, "enabled": False}).status_code == 409


def test_run_committed_before_disable_remains_successful_under_report_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A disable waits for in-flight finalization, then cancels only unfinished work."""

    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    ids: dict[str, UUID] = {}
    now = datetime.now(UTC)
    try:
        with AuditSession(engine) as setup:
            setup.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            owner = _actor(setup, {"records.read": True, "records.write": True})
            report, module = _report(setup, owner)
            field = setup.scalar(select(Field).where(Field.module_id == module.id))
            assert field is not None
            department_id, role_id = module.department_id, owner.role_id
            schedule = ReportSchedule(
                report_id=report.id,
                enabled=True,
                cadence="daily",
                timezone_name="UTC",
                local_time=datetime.now(UTC).time().replace(second=0, microsecond=0),
                next_due_at=now + timedelta(days=1),
            )
            work = ScheduledWork(
                report_id=report.id,
                scheduled_for=now,
                next_attempt_at=now,
                state=WorkState.RUNNING,
                lease_token=uuid7(),
                lease_expires_at=now + timedelta(minutes=5),
            )
            setup.add_all([schedule, work])
            setup.flush()
            run = ReportRun(
                report_id=report.id,
                module_id=module.id,
                idempotency_key=work.id,
                recipe_revision=report.revision,
                recipe=report.recipe,
                headings=["Status"],
                row_count=0,
                csv_bytes=b"Status\r\n",
            )
            setup.add(run)
            setup.commit()
            ids = {
                "owner": owner.id, "role": role_id, "report": report.id,
                "module": module.id, "department": department_id,
                "field": field.id, "work": work.id, "run": run.id,
                "lease": work.lease_token,
            }

        def request_db() -> Generator[Session, None, None]:
            with AuditSession(engine) as db:
                db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
                set_audit_actor(db, ids["owner"])
                yield db

        def request_user(db: Annotated[Session, Depends(get_db)]) -> User:
            user = db.scalar(
                select(User).options(joinedload(User.role)).where(User.id == ids["owner"])
            )
            assert user is not None
            return user

        app = FastAPI()
        app.include_router(router, prefix="/api")
        app.dependency_overrides[get_db] = request_db
        app.dependency_overrides[get_current_user] = request_user
        path = f"/api/reports/{ids['report']}/schedule"
        attempted = Event()
        original_report = schedule_router._report

        def signal_report(db: Session, actor: User, report_id: UUID, *, lock: bool) -> Report:
            attempted.set()
            return original_report(db, actor, report_id, lock=lock)

        monkeypatch.setattr(schedule_router, "_report", signal_report)

        def disable() -> Response:
            with TestClient(app) as client:
                return client.patch(path, json={"revision": 1, "enabled": False})

        with AuditSession(engine) as completion:
            completion.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
            claim = WorkClaim(ids["work"], ids["lease"])
            assert complete_report_work(completion, claim, ids["run"], now=now)
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(disable)
                assert attempted.wait(5), "Schedule edit did not reach the Report lock"
                assert not future.done()
                completion.commit()
                response = future.result(timeout=5)
                assert response.status_code == 200, response.text
        with AuditSession(engine) as verify:
            work = verify.get(ScheduledWork, ids["work"])
            policy = verify.scalar(
                select(ReportSchedule).where(ReportSchedule.report_id == ids["report"])
            )
            assert work is not None and work.state == WorkState.SUCCEEDED
            assert work.run_id == ids["run"]
            assert policy is not None and not policy.enabled and policy.revision == 2
    finally:
        if ids:
            with AuditSession(engine) as cleanup:
                cleanup.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
                report = cleanup.get(Report, ids["report"])
                assert report is not None
                delete_report_tree(cleanup, report)
                cleanup.flush()
                for model, key in (
                    (Field, "field"), (Module, "module"), (Department, "department"),
                    (User, "owner"), (Role, "role"),
                ):
                    row = cleanup.get(model, ids[key])
                    if row is not None:
                        cleanup.delete(row)
                        cleanup.flush()
                cleanup.commit()
        engine.dispose()
