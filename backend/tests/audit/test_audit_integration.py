import os
from datetime import UTC, datetime
from secrets import token_urlsafe

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.manage.audit.snapshots import REDACTED
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record

UPDATED_RENAMED_CANARY = token_urlsafe(32)
UPDATED_CLOSED_CANARY = token_urlsafe(32)
ADDED_FIELD_CANARY = token_urlsafe(32)
HISTORICAL_RENAMED_CANARY = token_urlsafe(32)
HISTORICAL_CLOSED_CANARY = token_urlsafe(32)

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


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


def test_record_audit_redaction_preserves_data_and_historical_snapshots(
    integration_db: Session,
) -> None:
    department = Department(department_name=f"Audit Redaction {uuid7()}")
    module = Module(
        department=department,
        module_name="Governance export",
    )
    renamed = Field(
        module=module,
        name="Original secret",
        type=FieldType.TEXT,
        position=0,
    )
    soft_deleted = Field(
        module=module,
        name="Closed secret",
        type=FieldType.TEXT,
        position=1,
    )
    added = Field(
        module=module,
        name="Added secret",
        type=FieldType.TEXT,
        position=2,
    )
    clear = Field(
        module=module,
        name="Visible value",
        type=FieldType.TEXT,
        position=3,
    )
    integration_db.add(department)
    integration_db.flush()

    record = Record(
        module=module,
        data={
            str(renamed.id): HISTORICAL_RENAMED_CANARY,
            str(soft_deleted.id): HISTORICAL_CLOSED_CANARY,
            str(clear.id): "historical visible",
        },
    )
    integration_db.add(record)
    integration_db.flush()
    historical_create = audit_rows(integration_db, record.id)[0]
    assert historical_create.action == AuditAction.CREATE
    assert historical_create.after["data"] == {
        str(renamed.id): HISTORICAL_RENAMED_CANARY,
        str(soft_deleted.id): HISTORICAL_CLOSED_CANARY,
        str(clear.id): "historical visible",
    }

    renamed.audit_redacted = True
    renamed.name = "Renamed secret"
    soft_deleted.audit_redacted = True
    soft_deleted.is_deleted = True
    soft_deleted.deleted_at = datetime.now(UTC)
    added.audit_redacted = True
    integration_db.flush()

    record.data = {
        str(renamed.id): UPDATED_RENAMED_CANARY,
        str(soft_deleted.id): UPDATED_CLOSED_CANARY,
        str(added.id): ADDED_FIELD_CANARY,
        str(clear.id): "updated visible",
    }
    integration_db.flush()
    updated = audit_rows(integration_db, record.id)[-1]
    assert updated.action == AuditAction.UPDATE
    assert updated.before["data"] == {
        str(renamed.id): REDACTED,
        str(soft_deleted.id): REDACTED,
        str(clear.id): "historical visible",
    }
    assert updated.after["data"] == {
        str(renamed.id): REDACTED,
        str(soft_deleted.id): REDACTED,
        str(added.id): REDACTED,
        str(clear.id): "updated visible",
    }

    record.data = {str(clear.id): "final visible"}
    integration_db.flush()
    removed = audit_rows(integration_db, record.id)[-1]
    assert removed.before["data"] == {
        str(renamed.id): REDACTED,
        str(soft_deleted.id): REDACTED,
        str(added.id): REDACTED,
        str(clear.id): "updated visible",
    }
    assert removed.after["data"] == {str(clear.id): "final visible"}
    assert record.data == {str(clear.id): "final visible"}
    assert historical_create.after["data"] == {
        str(renamed.id): HISTORICAL_RENAMED_CANARY,
        str(soft_deleted.id): HISTORICAL_CLOSED_CANARY,
        str(clear.id): "historical visible",
    }
