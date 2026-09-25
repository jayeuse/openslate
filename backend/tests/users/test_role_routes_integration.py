"""Database-backed HTTP tests for protected built-in role mutations."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.systems.access.users.models import IdentityKind, Role, User, UserRole, UserStatus
from app.systems.manage.audit.context import set_audit_actor

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("role_name", [UserRole.ADMIN, UserRole.MEMBER], ids=["admin", "member"])
def test_builtin_role_permissions_cannot_be_patched_over_http(
    integration_db: Session, role_name: UserRole
) -> None:
    target = integration_db.scalar(
        select(Role).where(Role.role == role_name.value, Role.is_deleted.is_(False))
    )
    admin_role = integration_db.scalar(
        select(Role).where(Role.role == UserRole.ADMIN.value, Role.is_deleted.is_(False))
    )
    assert isinstance(target, Role)
    assert isinstance(admin_role, Role)
    before = dict(target.permissions)

    suffix = uuid7().hex
    admin = User(
        email=f"role-patch-admin-{suffix}@example.test",
        username=f"role_patch_admin_{suffix[:16]}",
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
        role_id=admin_role.id,
        role=admin_role,
    )
    integration_db.add(admin)
    integration_db.flush()
    set_audit_actor(integration_db, admin.id)

    application = create_app()
    application.dependency_overrides[get_db] = lambda: integration_db
    application.dependency_overrides[get_current_user] = lambda: admin
    requested = {"records.read": not bool(before.get("records.read", False))}

    with TestClient(application, raise_server_exceptions=False) as client:
        response = client.patch(
            f"/api/roles/{target.id}", json={"permissions": requested}
        )

    stored = integration_db.scalar(select(Role.permissions).where(Role.id == target.id))
    assert (response.status_code, stored) == (403, before)
