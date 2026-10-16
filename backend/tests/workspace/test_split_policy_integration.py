"""The interim single-organization settings endpoint cannot grant install-wide authority."""

import pytest
from fastapi import HTTPException, Response
from sqlalchemy import select
from starlette.requests import Request
from uuid6 import uuid7

from app.common.dependencies.auth import CurrentIdentity
from app.core.database.organization_scope import scope_session
from app.systems.manage.workspace.models import PlatformSettings
from app.systems.manage.workspace.security_router import (
    get_workspace_security,
    update_workspace_security,
)
from app.systems.manage.workspace.security_schemas import WorkspaceSecurityUpdate
from tests.conftest import create_member, create_organization

pytestmark = pytest.mark.integration


def test_security_read_preserves_combined_policy_response(integration_owner_db):
    db = integration_owner_db
    org = create_organization(db, mfa_require_member=True)
    user, _membership = create_member(db, org, "admin")
    platform = db.scalars(select(PlatformSettings)).one()
    response = get_workspace_security(user, db, Response())
    assert response.mfa_require_member is True
    assert response.password_min_length == platform.password_min_length
    assert response.session_timeout_minutes == platform.session_timeout_minutes


def test_platform_security_change_requires_the_installation_owner(integration_owner_db):
    db = integration_owner_db
    org = create_organization(db)
    user, _membership = create_member(db, org, "admin")
    org.owner_user_id = user.id  # the organization owner, but not the installation owner
    create_organization(db)
    scope_session(db, org.id)  # the second organization exists; the admin acts in the first
    db.flush()
    platform = db.scalars(select(PlatformSettings)).one()
    prior = platform.session_timeout_minutes
    with pytest.raises(HTTPException) as refusal:
        update_workspace_security(
            WorkspaceSecurityUpdate(revision=org.revision, session_timeout_minutes=30),
            Request({"type": "http", "method": "PATCH", "path": "/api/workspace/security"}),
            CurrentIdentity(user, uuid7(), False, False), user, db, Response(),
        )
    # Installation-wide fields belong to the installation owner, not an organization admin.
    assert refusal.value.status_code == 403
    assert refusal.value.detail["code"] == "operator_required"
    assert platform.session_timeout_minutes == prior
    assert not db.dirty


def test_organization_security_change_requires_the_organization_owner(integration_owner_db):
    db = integration_owner_db
    org = create_organization(db)
    owner, _ = create_member(db, org, "admin")
    admin, _ = create_member(db, org, "admin")
    org.owner_user_id = owner.id
    db.flush()
    with pytest.raises(HTTPException) as refusal:
        update_workspace_security(
            WorkspaceSecurityUpdate(revision=org.revision, mfa_require_member=True),
            Request({"type": "http", "method": "PATCH", "path": "/api/workspace/security"}),
            CurrentIdentity(admin, uuid7(), False, False), admin, db, Response(),
        )
    # Another administrator does the rest, but sensitive security belongs to the owner.
    assert refusal.value.status_code == 403
    assert refusal.value.detail["code"] == "owner_required"
