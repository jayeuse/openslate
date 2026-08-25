import os

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.audit.models import AuditAction, AuditLog
from app.systems.departments.models import Department

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)


def audit_rows(session: Session, entity_id) -> list[AuditLog]:
    return list(
        session.scalars(
            select(AuditLog)
            .where(AuditLog.entity_id == entity_id)
            .order_by(AuditLog.created_at, AuditLog.id)
        ).all()
    )


def test_crud_changes_are_audited_with_minimal_snapshots(integration_db: Session) -> None:
    department = Department(department_name="Integration CRUD")
    integration_db.add(department)
    integration_db.flush()

    department.department_name = "Integration CRUD Updated"
    integration_db.flush()

    department.is_deleted = True
    integration_db.flush()

    rows = audit_rows(integration_db, department.id)
    assert [row.action for row in rows] == [
        AuditAction.CREATE,
        AuditAction.UPDATE,
        AuditAction.DELETE,
    ]
    assert rows[0].after == {"department_name": "Integration CRUD"}
    assert rows[1].before == {"department_name": "Integration CRUD"}
    assert rows[1].after == {"department_name": "Integration CRUD Updated"}
    assert rows[2].before["is_deleted"] is False
    assert rows[2].after["is_deleted"] is True
    assert all(row.performed_by is None for row in rows)


def test_rollback_does_not_keep_audit_rows(integration_db: Session) -> None:
    department = Department(department_name="Integration Rollback")
    integration_db.add(department)
    integration_db.flush()
    department_id = department.id

    assert len(audit_rows(integration_db, department_id)) == 1
    integration_db.rollback()

    assert integration_db.get(Department, department_id) is None


def test_hard_delete_records_the_previous_state(integration_db: Session) -> None:
    department = Department(department_name="Integration Hard Delete")
    integration_db.add(department)
    integration_db.flush()
    department_id = department.id

    integration_db.delete(department)
    integration_db.flush()

    rows = audit_rows(integration_db, department_id)
    assert [row.action for row in rows] == [AuditAction.CREATE, AuditAction.DELETE]
    assert rows[-1].before["department_name"] == "Integration Hard Delete"
    assert integration_db.get(Department, department_id) is None
