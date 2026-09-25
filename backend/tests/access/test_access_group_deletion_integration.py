"""Group deletion must not strand persisted policy rules."""

import os
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy import service
from app.systems.access.policy.models import AccessGroup, AccessRule
from app.systems.access.policy.schemas import AccessGroupCreate
from app.systems.access.users.models import IdentityKind, Role, User, UserRole, UserStatus
from app.systems.manage.audit.models import AuditLog


@pytest.mark.integration
@pytest.mark.skipif(
    os.getenv("TEST_DATABASE_URL") is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
@pytest.mark.parametrize("window", ["current", "future", "expired"])
def test_group_delete_blocks_any_non_deleted_targeted_rule_regardless_of_window(
    integration_db: Session, window: str
) -> None:
    role = integration_db.scalar(
        select(Role).where(Role.role == UserRole.MEMBER.value, Role.is_deleted.is_(False))
    )
    assert isinstance(role, Role)
    actor = User(
        id=uuid7(),
        email=f"group-delete-{uuid7().hex}@example.com",
        username=f"group-delete-{uuid7().hex[:12]}",
        role_id=role.id,
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
    )
    integration_db.add(actor)
    integration_db.commit()

    group = service.create_group(
        integration_db,
        AccessGroupCreate(name=f"Protected {uuid7().hex}"),
        actor.id,
    )
    now = datetime.now(UTC)
    starts_at = now + timedelta(days=1) if window == "future" else None
    ends_at = now - timedelta(days=1) if window == "expired" else None
    rule = AccessRule(
        id=uuid7(),
        subject_kind="group",
        subject_id=group.id,
        scope_kind="workspace",
        scope_id=None,
        permission_id="records.read",
        decision="deny",
        starts_at=starts_at,
        ends_at=ends_at,
        policy_version=1,
        performed_by=actor.id,
    )
    integration_db.add(rule)
    integration_db.commit()
    group_id = group.id
    rule_id = rule.id
    audit_count = integration_db.scalar(
        select(func.count()).select_from(AuditLog).where(AuditLog.entity_id == group_id)
    )

    with pytest.raises(HTTPException) as error:
        service.delete_group(integration_db, group_id, service.group_etag(group), actor.id)

    assert error.value.status_code == 409
    assert "Detailed rules" in error.value.detail
    integration_db.expire_all()
    stored_group = integration_db.get(AccessGroup, group_id)
    stored_rule = integration_db.get(AccessRule, rule_id)
    assert stored_group is not None and stored_group.is_deleted is False
    assert stored_rule is not None and stored_rule.is_deleted is False
    assert integration_db.scalar(
        select(func.count()).select_from(AuditLog).where(AuditLog.entity_id == group_id)
    ) == audit_count

    stored_rule.is_deleted = True
    stored_rule.deleted_at = now
    stored_rule.performed_by = actor.id
    integration_db.commit()
    service.delete_group(integration_db, group_id, service.group_etag(stored_group), actor.id)
    integration_db.refresh(stored_group)
    assert stored_group.is_deleted is True
