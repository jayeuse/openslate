"""PostgreSQL integration coverage for Access creation defaults."""

import os
from datetime import UTC, datetime, timedelta
from unittest.mock import Mock
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.roles_router as roles_router
import app.systems.access.users.service as user_service
from app.core.integrations.supabase_auth import ProviderUser
from app.systems.access.policy import service as policy_service
from app.systems.access.policy.models import (
    AccessDefaultDepartment,
    AccessDefaultGroup,
    AccessGroup,
    AccessGroupMember,
)
from app.systems.access.users.coordination import (
    InvitationError,
    active_admin_count,
    ensure_projected_admin_remains,
    is_active_admin,
)
from app.systems.access.users.models import (
    IdentityKind,
    Role,
    User,
    UserDepartment,
    UserRole,
    UserStatus,
)
from app.systems.access.users.schemas import InvitationCreate
from app.systems.manage.audit.context import set_audit_actor
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.exceptions import LifecyclePreflightError
from app.systems.sandbox.lifecycle.planner import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleTargetType
from app.systems.sandbox.lifecycle.service import close_lifecycle

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_creation_defaults_apply_only_to_new_users_in_postgresql(integration_db: Session) -> None:
    defaults = policy_service.get_defaults(integration_db, lock=True)
    admin_role = integration_db.scalar(
        select(Role).where(Role.role == UserRole.ADMIN.value, Role.is_deleted.is_(False))
    )
    assert isinstance(admin_role, Role)
    suffix = uuid7().hex
    actor = User(
        email=f"creation-default-admin-{suffix}@example.com",
        username=f"creation_default_admin_{suffix[:12]}",
        role_id=admin_role.id,
        role=admin_role,
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
    )
    integration_db.add(actor)
    integration_db.flush()
    set_audit_actor(integration_db, actor.id)

    department = Department(department_name=f"Default Department {uuid7().hex}")
    group = AccessGroup(name=f"Default Group {uuid7().hex}", description="")
    integration_db.add_all((department, group))
    integration_db.flush()
    integration_db.add_all(
        (
            AccessDefaultDepartment(
                policy_defaults_id=defaults.id,
                department_id=department.id,
            ),
            AccessDefaultGroup(policy_defaults_id=defaults.id, group_id=group.id),
        )
    )
    integration_db.flush()

    provider_users: dict[str, ProviderUser] = {}
    provider = Mock()

    def create_provider_user(
        email: str, local_user_id: UUID, operation_id: UUID
    ) -> ProviderUser:
        provider_user = ProviderUser(
            id=uuid7(),
            banned_until=None,
            email=email,
            app_metadata={
                "openslate_user_id": str(local_user_id),
                "openslate_invitation_operation_id": str(operation_id),
            },
        )
        provider_users[email] = provider_user
        return provider_user

    def send_provider_invitation(email: str) -> ProviderUser:
        return provider_users[email]

    provider.admin_create_invitation_user.side_effect = create_provider_user
    provider.admin_send_invitation.side_effect = send_provider_invitation

    user = user_service.invite_user(
        integration_db,
        InvitationCreate(
            email=f"default-{uuid7().hex}@example.com",
            username=f"default_{uuid7().hex[:12]}",
        ),
        actor_id=actor.id,
        client=provider,
    )

    memberships = integration_db.scalars(
        select(UserDepartment).where(UserDepartment.user_id == user.id)
    ).all()
    assert [(row.department_id, row.is_primary) for row in memberships] == [(department.id, False)]
    assert (
        integration_db.scalar(
            select(func.count())
            .select_from(AccessGroupMember)
            .where(AccessGroupMember.group_id == group.id, AccessGroupMember.user_id == user.id)
        )
        == 1
    )
    assert user.role_id == defaults.default_role_id

    existing = User(
        email=f"existing-{uuid7().hex}@example.com",
        username=f"existing_{uuid7().hex[:12]}",
        role_id=defaults.default_role_id,
        status="active",
        identity_kind="internal",
    )
    integration_db.add(existing)
    integration_db.flush()
    assert (
        integration_db.scalar(
            select(func.count())
            .select_from(UserDepartment)
            .where(UserDepartment.user_id == existing.id)
        )
        == 0
    )

    users_before = integration_db.scalar(select(func.count()).select_from(User))
    members_before = integration_db.scalar(select(func.count()).select_from(AccessGroupMember))
    group.is_deleted = True
    integration_db.commit()

    with pytest.raises(InvitationError, match="Access defaults"):
        user_service.invite_user(
            integration_db,
            InvitationCreate(
                email=f"blocked-{uuid7().hex}@example.com",
                username=f"blocked_{uuid7().hex[:12]}",
            ),
            actor_id=actor.id,
            client=provider,
        )

    assert integration_db.scalar(select(func.count()).select_from(User)) == users_before
    assert (
        integration_db.scalar(select(func.count()).select_from(AccessGroupMember)) == members_before
    )

@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_default_department_close_is_blocked_before_invitations_break(
    integration_db: Session,
) -> None:
    defaults = policy_service.get_defaults(integration_db, lock=True)
    department = Department(department_name=f"Protected {uuid7().hex}")
    integration_db.add(department)
    integration_db.flush()
    integration_db.add(
        AccessDefaultDepartment(policy_defaults_id=defaults.id, department_id=department.id)
    )
    integration_db.commit()

    preview = plan_lifecycle(
        integration_db, LifecycleTargetType.DEPARTMENT, department.id, "close", None
    )
    assert any("default" in blocker.detail.lower() for blocker in preview.blockers)

    with pytest.raises(LifecyclePreflightError, match="default"):
        close_lifecycle(
            integration_db,
            LifecycleTargetType.DEPARTMENT,
            department.id,
            None,
            plan=preview,
        )

    assert department.is_deleted is False
    assert policy_service.load_creation_defaults(integration_db).department_ids == (department.id,)

@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_configured_default_role_cannot_be_deleted_in_postgresql(
    integration_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    defaults = policy_service.get_defaults(integration_db, lock=True)
    role = Role(role=f"custom-{uuid7().hex}", permissions={})
    integration_db.add(role)
    integration_db.flush()
    defaults.default_role_id = role.id
    integration_db.commit()
    actor = User(id=uuid7(), role_id=role.id)
    monkeypatch.setattr(roles_router, "require_fresh_exact_admin", lambda *_args: actor)

    with pytest.raises(HTTPException, match="default role") as error:
        roles_router.delete_role(role.id, actor, integration_db)

    assert error.value.status_code == 409
    assert role.is_deleted is False
    assert policy_service.load_creation_defaults(integration_db).role.id == role.id

@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_expired_administrator_is_not_counted_as_usable_in_postgresql(
    integration_db: Session,
) -> None:
    admin_role = integration_db.scalar(select(Role).where(Role.role == UserRole.ADMIN.value))
    assert admin_role is not None
    before = active_admin_count(integration_db)
    current = User(
        email=f"current-{uuid7().hex}@example.com",
        username=f"current_{uuid7().hex[:12]}",
        role_id=admin_role.id,
        role=admin_role,
        status="active",
        identity_kind="internal",
    )
    expired = User(
        email=f"expired-{uuid7().hex}@example.com",
        username=f"expired_{uuid7().hex[:12]}",
        role_id=admin_role.id,
        role=admin_role,
        status="active",
        identity_kind="internal",
        expires_at=datetime.now(UTC) - timedelta(days=1),
    )
    integration_db.add_all((current, expired))
    integration_db.flush()

    assert is_active_admin(current) is True
    assert is_active_admin(expired) is False
    assert active_admin_count(integration_db) == before + 1

@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_default_group_keeps_pending_invite_during_member_edits_in_postgresql(
    integration_db: Session,
) -> None:
    defaults = policy_service.get_defaults(integration_db, lock=True)
    group = AccessGroup(name=f"Invitations {uuid7().hex}", description="")
    integration_db.add(group)
    integration_db.flush()
    integration_db.add(AccessDefaultGroup(policy_defaults_id=defaults.id, group_id=group.id))
    pending = User(
        email=f"pending-{uuid7().hex}@example.com",
        username=f"pending_{uuid7().hex[:12]}",
        role_id=defaults.default_role_id,
        status=UserStatus.PENDING.value,
        identity_kind=IdentityKind.INTERNAL.value,
        invitation_sent_at=datetime.now(UTC),
    )
    active = User(
        email=f"active-{uuid7().hex}@example.com",
        username=f"active_{uuid7().hex[:12]}",
        role_id=defaults.default_role_id,
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
    )
    integration_db.add_all((pending, active))
    integration_db.flush()
    integration_db.add(AccessGroupMember(group_id=group.id, user_id=pending.id))
    integration_db.commit()

    assert policy_service.replace_group_members(
        integration_db, group, [pending.id, active.id], uuid7()
    )
    assert {
        row.user_id
        for row in integration_db.scalars(
            select(AccessGroupMember).where(AccessGroupMember.group_id == group.id)
        )
    } == {pending.id, active.id}

@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_future_expiring_admin_cannot_replace_the_only_durable_admin(
    integration_db: Session,
) -> None:
    admin_role = integration_db.scalar(select(Role).where(Role.role == UserRole.ADMIN.value))
    assert admin_role is not None
    assert active_admin_count(integration_db) == 0
    durable = User(
        email=f"durable-{uuid7().hex}@example.com",
        username=f"durable_{uuid7().hex[:12]}",
        role_id=admin_role.id,
        role=admin_role,
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
    )
    future_expiring = User(
        email=f"future-{uuid7().hex}@example.com",
        username=f"future_{uuid7().hex[:12]}",
        role_id=admin_role.id,
        role=admin_role,
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
        expires_at=datetime.now(UTC) + timedelta(days=1),
    )
    integration_db.add_all((durable, future_expiring))
    integration_db.flush()

    assert active_admin_count(integration_db) == 2
    assert active_admin_count(integration_db, durable=True) == 1
    with pytest.raises(HTTPException, match="durable admin"):
        ensure_projected_admin_remains(
            integration_db,
            durable,
            destination_role=admin_role,
            destination_status=UserStatus.DISABLED.value,
        )
    assert durable.status == UserStatus.ACTIVE.value
