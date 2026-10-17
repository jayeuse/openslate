"""Retained Reports and run rows block physical source purges in preview."""

from datetime import UTC, datetime

import pytest
from uuid6 import uuid7
from views.test_access import actor

from app.systems.openview.reports.models import Report, ReportRun, ReportRunRow
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.exceptions import (
    LifecyclePlanDriftError,
    LifecyclePreflightError,
)
from app.systems.sandbox.lifecycle.execution import execute_lifecycle
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.rbac.support import organization
from tests.sandbox_designs.fixtures import create_document

pytestmark = pytest.mark.integration


def test_retained_archived_run_blocks_record_module_and_department_purge(integration_db) -> None:
    db = integration_db
    now = datetime.now(UTC)
    owner = actor(db)
    org = organization(db)
    create_document(db, org)
    department = Department(
        org_id=org.id,
        department_name=f"Retained Report {uuid7()}", is_deleted=True, deleted_at=now
    )
    db.add(department)
    db.flush()
    module = Module(
        org_id=department.org_id,
        department_id=department.id,
        module_name="Retained source",
        is_deleted=True,
        deleted_at=now,
    )
    db.add(module)
    db.flush()
    record = Record(org_id=module.org_id,
                    module_id=module.id, data={}, is_deleted=True, deleted_at=now)
    report = Report(
        org_id=module.org_id,
        module_id=module.id,
        name="Archived report",
        recipe={"version": 1},
        is_deleted=True,
        deleted_at=now,
    )
    db.add_all([record, report])
    db.flush()
    run = ReportRun(
        org_id=report.org_id,
        report_id=report.id,
        module_id=module.id,
        idempotency_key=uuid7(),
        recipe_revision=1,
        recipe={"version": 1},
        headings=["Name"],
        row_count=1,
        csv_bytes=b"Name\r\nReady\r\n",
        is_deleted=True,
        deleted_at=now,
    )
    db.add(run)
    db.flush()
    row = ReportRunRow(
        org_id=run.org_id,
        run_id=run.id,
        position=0,
        record_id=record.id,
        cells=["Ready"],
        is_deleted=True,
        deleted_at=now,
    )
    db.add(row)
    db.commit()

    for target_type, target_id in (
        ("record", record.id),
        ("module", module.id),
        ("department", department.id),
    ):
        plan = plan_lifecycle(db, target_type, target_id, "purge", owner.id)
        assert any(
            blocker.code == "purge_report_run_dependency" and blocker.entity_id == row.id
            for blocker in plan.blockers
        )
        assert row.id in plan.scope_ids["report_run_rows"]
        assert any(
            state.entity_type == "report_run_rows" and state.entity_id == row.id
            for state in plan.rows
        )
        with pytest.raises(LifecyclePreflightError):
            execute_lifecycle(db, plan)
        assert db.get(Record, record.id) is not None
        assert db.get(ReportRunRow, row.id) is not None

    module_plan = plan_lifecycle(db, "module", module.id, "purge", owner.id)
    assert any(
        blocker.code == "purge_report_dependency" and blocker.entity_id == report.id
        for blocker in module_plan.blockers
    )
    assert report.id in module_plan.scope_ids["reports"]
    assert run.id in module_plan.scope_ids["report_runs"]

    stale_plan = plan_lifecycle(db, "record", record.id, "purge", owner.id)
    later_run = ReportRun(
        org_id=report.org_id,
        report_id=report.id,
        module_id=module.id,
        idempotency_key=uuid7(),
        recipe_revision=1,
        recipe={"version": 1},
        headings=["Name"],
        row_count=1,
        csv_bytes=b"Name\r\nLater\r\n",
    )
    db.add(later_run)
    db.flush()
    later_row = ReportRunRow(
        org_id=later_run.org_id,
        run_id=later_run.id,
        position=0,
        record_id=record.id,
        cells=["Later"],
    )
    db.add(later_row)
    db.commit()
    with pytest.raises(LifecyclePlanDriftError):
        execute_lifecycle(db, stale_plan)
    assert db.get(ReportRunRow, later_row.id) is not None


def test_archived_report_recipe_blocks_empty_module_purge(integration_db) -> None:
    db = integration_db
    now = datetime.now(UTC)
    owner = actor(db)
    org = organization(db)
    create_document(db, org)
    department = Department(org_id=org.id, department_name=f"Empty Report {uuid7()}")
    db.add(department)
    db.flush()
    module = Module(
        org_id=department.org_id,
        department_id=department.id,
        module_name="Empty source",
        is_deleted=True,
        deleted_at=now,
    )
    db.add(module)
    db.flush()
    report = Report(
        org_id=module.org_id,
        module_id=module.id,
        name="Archived empty report",
        recipe={"version": 1},
        is_deleted=True,
        deleted_at=now,
    )
    db.add(report)
    db.commit()

    plan = plan_lifecycle(db, "module", module.id, "purge", owner.id)
    assert any(
        blocker.code == "purge_report_dependency" and blocker.entity_id == report.id
        for blocker in plan.blockers
    )
    assert report.id in plan.scope_ids["reports"]
