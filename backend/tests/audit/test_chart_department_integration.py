"""Real Chart audit rows derive ownership from Module ancestry, including stale metadata."""

import pytest
from sqlalchemy import select

from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.manage.audit.snapshots import REDACTED
from app.systems.openview.charts.models import Chart
from tests.rbac.support import add_department, add_module

pytestmark = pytest.mark.integration
QUERY_CANARY = "owned private Chart query canary"


def _chart(db, module, department_id):
    row = Chart(
        org_id=module.org_id,
        module_id=module.id,
        department_id=department_id,
        name="Owned audit Chart",
        chart_type="records",
        query={
            "module_id": str(module.id),
            "definition": {"version": 1, "columns": [], "search": QUERY_CANARY},
        },
    )
    db.add(row)
    db.flush()
    return row


def _log(db, chart_id, action):
    row = db.scalar(
        select(AuditLog)
        .where(
            AuditLog.entity_type == "charts",
            AuditLog.entity_id == chart_id,
            AuditLog.action == action,
        )
        .order_by(AuditLog.id.desc())
    )
    assert row is not None
    assert QUERY_CANARY not in repr(row.before) + repr(row.after)
    return row


def test_new_and_detached_chart_audit_derives_actual_module_department_and_redacts_query(
    integration_db,
):
    db = integration_db
    source = add_department(db)
    stale = add_department(db)
    module = add_module(db, source)
    chart = _chart(db, module, stale.id)
    identifier, department_id = chart.id, source.id
    created = _log(db, identifier, AuditAction.CREATE)
    created_id = created.id
    assert created.department_id == department_id
    assert created.after["query"] == REDACTED
    db.commit()
    db.expunge_all()
    detached_parent_chart = db.get(Chart, identifier)
    detached_parent_chart.name = "Read parent from database"
    db.flush()
    updated = _log(db, identifier, AuditAction.UPDATE)
    assert updated.department_id == department_id
    assert db.get(AuditLog, created_id).department_id == department_id


def test_same_flush_module_move_and_parent_delete_preserve_chart_audit_ancestry(integration_db):
    db = integration_db
    source = add_department(db)
    destination = add_department(db)
    module = add_module(db, source)
    chart = _chart(db, module, source.id)
    identifier, old_department, new_department = chart.id, source.id, destination.id
    created = _log(db, identifier, AuditAction.CREATE)
    module.department_id = new_department
    chart.name = "Changed with moved Module and stale Chart department"
    db.flush()
    updated = _log(db, identifier, AuditAction.UPDATE)
    assert updated.department_id == new_department
    assert chart.department_id == old_department
    db.delete(chart)
    db.delete(module)
    db.delete(destination)
    db.flush()
    deleted = _log(db, identifier, AuditAction.DELETE)
    assert deleted.department_id == new_department
    assert db.get(AuditLog, created.id).department_id == old_department
    assert deleted.before["query"] == REDACTED
