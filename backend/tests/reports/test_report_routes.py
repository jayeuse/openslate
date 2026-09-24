"""Private Report recipe routes on runner-owned PostgreSQL."""

from datetime import UTC, datetime, time
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.openview.reports.models import (
    Report,
    ReportRun,
    ReportRunEligibleUser,
    ReportRunRow,
)
from app.systems.openview.reports.router import router
from app.systems.openview.reports.schedule_models import ReportSchedule
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork, WorkState
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.lifecycle.report_dependencies import load_report_purge_dependencies
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record

pytestmark = pytest.mark.integration


def _actor(
    db: Session, *, permissions: dict[str, bool] | None = None, role: Role | None = None
) -> User:
    if role is None:
        role = Role(role=f"report-{uuid7().hex}", permissions=permissions or {})
        db.add(role)
        db.flush()
    user_id = uuid7()
    user = User(
        id=user_id,
        email=f"report-{user_id.hex}@example.test",
        username=f"report_{user_id.hex[:20]}",
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
        role=role,
    )
    db.add(user)
    db.flush()
    return user


def _client(db: Session, user: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def _module(db: Session, *, accepted: bool = True) -> tuple[Module, Field]:
    department = Department(department_name=f"Report source {uuid7()}")
    db.add(department)
    db.flush()
    module = Module(
        department_id=department.id,
        module_name=f"Report source {uuid7()}",
        is_schema_accepted=accepted,
    )
    db.add(module)
    db.flush()
    field = Field(
        module_id=module.id,
        name="Category",
        type=FieldType.TEXT,
        required=False,
        position=0,
        config={},
    )
    db.add(field)
    db.flush()
    return module, field


def _recipe(field: Field) -> dict[str, object]:
    reference = {"field_id": str(field.id), "expected_type": str(field.type)}
    return {
        "version": 1,
        "fields": [reference],
        "filters": [],
        "logic": "and",
        "sorts": [{**reference, "direction": "asc"}],
        "group_by": reference,
        "include_row_count": True,
    }


def test_private_report_recipe_create_list_read_update_and_stale_revision(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, permissions={"records.read": True, "records.write": True})
    module, field = _module(db)
    set_audit_actor(db, owner.id)

    with _client(db, owner) as client:
        created = client.post(
            "/api/reports",
            json={
                "module_id": str(module.id),
                "name": "  Weekly operations  ",
                "subtitle": "  Open work  ",
                "recipe": _recipe(field),
            },
        )
        assert created.status_code == 201
        report_id = UUID(created.json()["id"])
        assert created.headers["location"] == f"/api/reports/{report_id}"
        assert created.headers["cache-control"] == "private, no-store"
        assert created.json()["owner_id"] == str(owner.id)
        assert created.json()["name"] == "Weekly operations"
        assert created.json()["recipe"]["fields"][0]["field_id"] == str(field.id)
        assert created.json()["revision"] == 1

        listed = client.get("/api/reports?limit=1&offset=0")
        assert listed.status_code == 200
        assert [item["id"] for item in listed.json()["items"]] == [str(report_id)]
        assert listed.json()["pagination"]["total"] == 1
        assert client.get(f"/api/reports/{report_id}").status_code == 200

        changed = client.patch(
            f"/api/reports/{report_id}",
            json={"revision": 1, "name": "Monthly operations", "subtitle": None},
        )
        assert changed.status_code == 200
        assert changed.json()["revision"] == 2
        assert changed.json()["subtitle"] is None
        stale = client.patch(f"/api/reports/{report_id}", json={"revision": 1, "name": "Stale"})
        assert stale.status_code == 409
        assert stale.json()["detail"]["code"] == "stale_revision"
        assert stale.json()["detail"]["current_revision"] == 2

    stored = db.get(Report, report_id)
    assert stored is not None and stored.name == "Monthly operations"
    audit = db.scalars(
        select(AuditLog)
        .where(AuditLog.entity_type == "reports", AuditLog.entity_id == report_id)
        .order_by(AuditLog.created_at, AuditLog.id)
    ).all()
    assert [row.action for row in audit] == [AuditAction.CREATE, AuditAction.UPDATE]
    assert all(row.performed_by == owner.id for row in audit)


def test_private_report_owner_and_active_source_are_enforced(integration_owner_db: Session) -> None:
    db = integration_owner_db
    owner = _actor(db, permissions={"records.read": True, "records.write": True})
    outsider = _actor(db, permissions={"records.read": True, "records.write": True})
    read_only_owner = _actor(db, permissions={"records.read": True})
    admin_role = db.scalar(select(Role).where(Role.role == "admin", Role.is_deleted.is_(False)))
    assert admin_role is not None
    admin = _actor(db, role=admin_role)
    module, field = _module(db)
    inactive_module, inactive_field = _module(db, accepted=False)
    set_audit_actor(db, owner.id)

    with _client(db, owner) as client:
        created = client.post(
            "/api/reports",
            json={"module_id": str(module.id), "name": "Private", "recipe": _recipe(field)},
        )
        assert created.status_code == 201
        report_id = created.json()["id"]
        assert (
            client.post(
                "/api/reports",
                json={
                    "module_id": str(inactive_module.id),
                    "name": "Unavailable",
                    "recipe": _recipe(inactive_field),
                },
            ).status_code
            == 409
        )
        invalid_field = client.patch(
            f"/api/reports/{report_id}",
            json={"revision": 1, "recipe": _recipe(inactive_field)},
        )
        assert invalid_field.status_code == 409
        assert invalid_field.json()["detail"]["code"] == "report_invalid"
        assert client.get(f"/api/reports/{report_id}").json()["revision"] == 1
        assert (
            client.patch(
                f"/api/reports/{report_id}",
                json={"revision": 1, "module_id": str(inactive_module.id)},
            ).status_code
            == 409
        )

    for user in (outsider, read_only_owner, admin):
        with _client(db, user) as client:
            assert client.get("/api/reports").json()["pagination"]["total"] == 0
            assert client.get(f"/api/reports/{report_id}").status_code == 404
            assert client.patch(
                f"/api/reports/{report_id}", json={"revision": 1, "name": "Takeover"}
            ).status_code in {403, 404}
    with _client(db, read_only_owner) as client:
        assert (
            client.post(
                "/api/reports",
                json={"module_id": str(module.id), "name": "Denied", "recipe": _recipe(field)},
            ).status_code
            == 403
        )


def test_report_archive_restore_and_permanent_delete_preserve_then_release_runs(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, permissions={"records.read": True, "records.write": True})
    outsider = _actor(db, permissions={"records.read": True, "records.write": True})
    read_only = _actor(db, permissions={"records.read": True})
    module, field = _module(db)
    set_audit_actor(db, owner.id)
    with _client(db, owner) as client:
        created = client.post(
            "/api/reports",
            json={"module_id": str(module.id), "name": "Retained", "recipe": _recipe(field)},
        )
        assert created.status_code == 201
        report_id = UUID(created.json()["id"])
        path = f"/api/reports/{report_id}"
        assert client.delete(f"{path}/permanent?revision=1").status_code == 409
        assert client.delete(f"{path}?revision=2").json()["detail"]["code"] == "stale_revision"

    record = Record(module_id=module.id, data={})
    db.add(record)
    db.flush()
    run = ReportRun(
        report_id=report_id,
        module_id=module.id,
        idempotency_key=uuid7(),
        recipe_revision=1,
        recipe=_recipe(field),
        headings=["Category"],
        row_count=1,
        csv_bytes=b"Category\r\nReady\r\n",
    )
    db.add(run)
    db.flush()
    row = ReportRunRow(run_id=run.id, record_id=record.id, position=0, cells=["Ready"])
    db.add(row)
    eligible_user = ReportRunEligibleUser(run_id=run.id, user_id=owner.id)
    db.add(eligible_user)
    scheduled_for = datetime.now(UTC)
    work = ScheduledWork(
        report_id=report_id,
        scheduled_for=scheduled_for,
        next_attempt_at=scheduled_for,
        state=WorkState.SUCCEEDED,
        run_id=run.id,
    )
    db.add(work)
    db.flush()
    notification = InAppNotification(work_id=work.id, recipient_id=owner.id)
    db.add(notification)
    schedule = ReportSchedule(
        report_id=report_id,
        enabled=True,
        cadence="daily",
        timezone_name="UTC",
        local_time=time(9),
        next_due_at=scheduled_for,
    )
    db.add(schedule)
    db.commit()

    with _client(db, outsider) as client:
        assert client.delete(f"{path}?revision=1").status_code == 404
        assert client.post(f"{path}/restore", json={"revision": 1}).status_code == 404
        assert client.delete(f"{path}/permanent?revision=1").status_code == 404
    with _client(db, read_only) as client:
        assert client.delete(f"{path}?revision=1").status_code == 403
        assert client.delete(f"{path}/permanent?revision=1").status_code == 403

    with _client(db, owner) as client:
        archived = client.delete(f"{path}?revision=1")
        assert archived.status_code == 204
        assert client.get(path).json()["is_deleted"] is True
        assert client.get(f"{path}/runs/{run.id}").status_code == 409
        stale_delete = client.delete(f"{path}/permanent?revision=1")
        assert stale_delete.json()["detail"]["code"] == "stale_revision"
        assert client.delete(f"{path}?revision=2").json()["detail"]["code"] == "report_archived"
        assert db.get(ReportRun, run.id) is not None
        assert db.get(ReportRunRow, row.id) is not None
        assert db.get(ReportRunEligibleUser, (run.id, owner.id)) is not None
        assert db.get(ScheduledWork, work.id) is not None
        assert db.get(InAppNotification, notification.id) is not None
        assert db.get(ReportSchedule, schedule.id) is not None
        _, blocked, _ = load_report_purge_dependencies(
            db, [module.id], [record.id], lambda _: "state"
        )
        assert any(blocker.entity_id == row.id for blocker in blocked)

        restored = client.post(f"{path}/restore", json={"revision": 2})
        assert restored.status_code == 200
        assert restored.json()["revision"] == 3
        assert restored.json()["is_deleted"] is False
        assert client.get(f"{path}/runs/{run.id}").status_code == 200
        assert client.delete(f"{path}?revision=3").status_code == 204
        deleted = client.delete(f"{path}/permanent?revision=4")
        assert deleted.status_code == 204, deleted.text
        assert client.get(path).status_code == 404

    assert db.get(Report, report_id) is None
    assert db.get(ReportRun, run.id) is None
    assert db.get(ReportRunRow, row.id) is None
    assert db.get(ReportRunEligibleUser, (run.id, owner.id)) is None
    assert db.get(ScheduledWork, work.id) is None
    assert db.get(InAppNotification, notification.id) is None
    assert db.get(ReportSchedule, schedule.id) is None
    _, blockers, _ = load_report_purge_dependencies(db, [module.id], [record.id], lambda _: "state")
    assert not blockers
    audit = db.scalars(
        select(AuditLog)
        .where(AuditLog.entity_type == "reports", AuditLog.entity_id == report_id)
        .order_by(AuditLog.created_at, AuditLog.id)
    ).all()
    assert [entry.action for entry in audit] == [
        AuditAction.CREATE,
        AuditAction.DELETE,
        AuditAction.UPDATE,
        AuditAction.DELETE,
        AuditAction.DELETE,
    ]
    child_deletions = db.scalars(
        select(AuditLog).where(
            AuditLog.entity_id.in_([run.id, row.id, notification.id, schedule.id]),
            AuditLog.action == AuditAction.DELETE,
        )
    ).all()
    assert {entry.entity_id for entry in child_deletions} == {
        run.id,
        row.id,
        notification.id,
        schedule.id,
    }


def test_report_permanent_delete_rolls_back_flushed_child_deletions_on_conflict(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    owner = _actor(db, permissions={"records.read": True, "records.write": True})
    module, field = _module(db)
    report = Report(
        owner_id=owner.id,
        module_id=module.id,
        name="Rollback snapshot",
        recipe=_recipe(field),
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    record = Record(module_id=module.id, data={})
    db.add_all([report, record])
    db.flush()
    run = ReportRun(
        report_id=report.id,
        module_id=module.id,
        idempotency_key=uuid7(),
        recipe_revision=1,
        recipe=_recipe(field),
        headings=["Category"],
        row_count=1,
        csv_bytes=b"Category\r\nReady\r\n",
    )
    db.add(run)
    db.flush()
    row = ReportRunRow(run_id=run.id, record_id=record.id, position=0, cells=["Ready"])
    db.add(row)
    schedule = ReportSchedule(
        report_id=report.id,
        enabled=True,
        cadence="daily",
        timezone_name="UTC",
        local_time=time(9),
        next_due_at=datetime.now(UTC),
    )
    db.add(schedule)
    db.commit()
    report_id = report.id
    set_audit_actor(db, owner.id)

    actual_flush = db.flush

    def conflict_after_flush(*args: object, **kwargs: object) -> None:
        deleting = bool(db.deleted)
        actual_flush(*args, **kwargs)
        if deleting:
            raise IntegrityError("forced child delete conflict", {}, RuntimeError("conflict"))

    with monkeypatch.context() as patch:
        patch.setattr(db, "flush", conflict_after_flush)
        with _client(db, owner) as client:
            result = client.delete(f"/api/reports/{report_id}/permanent?revision=1")
    assert result.status_code == 409
    assert result.json()["detail"]["code"] == "report_delete_conflict"
    assert db.get(Report, report.id) is not None
    assert db.get(ReportRun, run.id) is not None
    assert db.get(ReportRunRow, row.id) is not None
    assert db.get(ReportSchedule, schedule.id) is not None
    hard_deletes = db.scalars(
        select(AuditLog).where(
            AuditLog.entity_id.in_([report.id, run.id, row.id, schedule.id]),
            AuditLog.action == AuditAction.DELETE,
        )
    ).all()
    assert hard_deletes == []


def test_report_run_eligible_users_reject_duplicate_and_orphan_links(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    recipient = _actor(db)
    module, field = _module(db)
    report = Report(owner_id=owner.id, module_id=module.id, name="Roster", recipe=_recipe(field))
    db.add(report)
    db.flush()
    run = ReportRun(
        report_id=report.id,
        module_id=module.id,
        idempotency_key=uuid7(),
        recipe_revision=1,
        recipe=_recipe(field),
        headings=["Category"],
        row_count=0,
        csv_bytes=b"Category\r\n",
    )
    db.add(run)
    db.flush()
    db.add(ReportRunEligibleUser(run_id=run.id, user_id=recipient.id))
    db.flush()

    for run_id, user_id in (
        (run.id, recipient.id),
        (uuid7(), recipient.id),
        (run.id, uuid7()),
    ):
        with pytest.raises(IntegrityError), db.begin_nested():
            db.add(ReportRunEligibleUser(run_id=run_id, user_id=user_id))
            db.flush()

    assert db.get(ReportRunEligibleUser, (run.id, recipient.id)) is not None
