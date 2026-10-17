"""S04 entity-owned audit attribution, without an organization in AuditContext."""

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.access.users.models import Membership, PlatformOperator, User
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.workspace.models import PlatformSettings, WorkspaceProfile
from app.systems.platform.files.models import File
from app.systems.platform.scheduling.models import InAppNotification
from tests.conftest import create_member, create_organization

pytestmark = pytest.mark.integration


def test_audit_keeps_global_and_organization_mutations(integration_owner_db):
    db = integration_owner_db
    identity = uuid7()
    user = User(email=f"audit-{identity}@example.test", username=f"audit-{identity}",
                status="active")
    organization = WorkspaceProfile(slug=f"audit-{identity}", display_name="Audit organization",
                                    timezone="UTC", locale="en-US")
    db.add_all([user, organization])
    db.flush()
    membership = Membership(org_id=organization.id, user_id=user.id, role="admin", status="active")
    operator = PlatformOperator(user_id=user.id)
    platform = db.scalars(select(PlatformSettings)).one()
    platform.password_min_length += 1
    db.add_all([membership, operator])
    db.commit()

    expected = {
        ("users", user.id): None,
        ("organizations", organization.id): organization.id,
        ("memberships", membership.id): organization.id,
        ("platform_operators", operator.id): None,
        ("platform_settings", platform.id): None,
    }
    rows = db.scalars(select(AuditLog).where(AuditLog.entity_id.in_(
        [identity for _table, identity in expected]
    ))).all()
    assert {(row.entity_type, row.entity_id): row.org_id for row in rows} == expected


@pytest.mark.parametrize("entity_type", ["memberships", "departments", "files", "unknown_entity"])
def test_database_rejects_unattributed_organization_audit(integration_owner_db, entity_type):
    db = integration_owner_db
    with pytest.raises(IntegrityError) as refusal, db.begin_nested():
        db.connection().execute(AuditLog.__table__.insert().values(
            action="create", entity_type=entity_type, entity_id=uuid7(), org_id=None,
        ))
    assert refusal.value.orig.diag.constraint_name == "ck_audit_logs_organization"


def test_security_event_attribution_waits_for_s08(integration_owner_db):
    db = integration_owner_db
    event = append_security_event(db, SecurityEventIngestRequest(
        event_type="user.invitation", outcome="attempt", source="users.invitation",
        operation_id=uuid7(),
    ))
    db.commit()
    db.refresh(event)
    assert event.org_id is None


@pytest.mark.parametrize("entity_type", [
    "users", "platform_settings", "platform_operators", "backup_policies", "backup_runs",
    "backup_export_operations", "update_statuses",
])
def test_database_accepts_installation_audit(integration_owner_db, entity_type):
    result = integration_owner_db.connection().execute(AuditLog.__table__.insert().values(
        action="create", entity_type=entity_type, entity_id=uuid7(), org_id=None,
    ).returning(AuditLog.org_id))
    assert result.scalar_one() is None


@pytest.mark.parametrize("kind", ["avatar", "logo", "backup", "invitation"])
def test_mixed_audit_tracks_source_organization_through_update_and_delete(
    integration_owner_db, kind,
):
    db = integration_owner_db
    org = create_organization(db)
    user, _membership = create_member(db, org)
    org_id = None if kind in {"avatar", "backup"} else org.id
    if kind in {"avatar", "logo"}:
        row = File(org_id=org_id, purpose="user_avatar" if kind == "avatar" else "workspace_logo",
                   creator_id=user.id, filename="audit.png", expected_size=1,
                   object_key=f"audit/{uuid7()}")
    else:
        row = InAppNotification(
            org_id=org_id, kind="backup-failed" if kind == "backup" else "invitation-accepted",
            subject_type="backup_run" if kind == "backup" else "user", subject_id=user.id,
            recipient_id=user.id,
        )
    db.add(row)
    db.commit()
    if isinstance(row, File):
        row.state = "uploading"
    else:
        row.read_at = utc_now()
    db.commit()
    assert row.is_deleted is False
    row.is_deleted = True
    db.commit()
    identity = row.id
    db.delete(row)
    db.commit()
    logs = db.scalars(select(AuditLog).where(AuditLog.entity_id == identity)
                      .order_by(AuditLog.created_at, AuditLog.id)).all()
    assert len(logs) == 4
    assert [log.action for log in logs] == ["create", "update", "delete", "delete"]
    assert [log.org_id for log in logs] == [org_id] * 4
    for log in logs:
        source = log.after if log.after is not None else log.before
        assert source["org_id"] == (str(org_id) if org_id is not None else None)
        if kind in {"avatar", "logo"}:
            assert source["purpose"] == row.purpose
        else:
            assert source["kind"] == row.kind


@pytest.mark.parametrize("entity_type,proof", [
    ("files", {"org_id": "01900000-0000-7000-8000-000000000001", "purpose": "workspace_logo"}),
    ("files", {"org_id": None, "purpose": "workspace_logo"}),
    ("files", {"purpose": "user_avatar"}),
    ("in_app_notifications", {"org_id": None, "kind": "invitation-accepted"}),
    ("in_app_notifications", {"kind": "backup-failed"}),
])
@pytest.mark.parametrize("action", ["create", "update", "delete"])
def test_database_refuses_null_mixed_audit_without_global_row_proof(
    integration_owner_db, entity_type, proof, action,
):
    db = integration_owner_db
    with pytest.raises(IntegrityError) as refusal, db.begin_nested():
        db.connection().execute(AuditLog.__table__.insert().values(
            action=action, entity_type=entity_type, entity_id=uuid7(), org_id=None,
            **{"before" if action == "delete" else "after": proof},
        ))
    assert refusal.value.orig.diag.constraint_name == "ck_audit_logs_organization"
