"""S2: every signed-in person of the bound organization reads the system status, and the read
writes nothing (PostgreSQL)."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_current_user
from app.core.database.organization_scope import scope_session
from app.core.database.session import get_db
from app.main import create_app
from app.systems.access.policy.models import AccessLevel, Group, GroupAccess, GroupMember
from app.systems.access.users.models import User
from app.systems.manage.audit.models import AuditLog, SecurityEvent
from app.systems.manage.health import service
from app.systems.sandbox.departments.models import Department
from tests.conftest import create_member, create_organization
from tests.organization_scope_support import scoped_override

pytestmark = pytest.mark.integration

READY = {
    "status": "ready",
    "components": {
        name: {"status": "ready", "required": True}
        for name in ("database", "auth", "storage", "smtp")
    },
}


@pytest.fixture
def people(integration_db: Session, monkeypatch) -> tuple[Session, UUID, dict[str, User]]:
    monkeypatch.setattr(service, "_cached", None)
    monkeypatch.setattr(service, "get_readiness_snapshot", lambda: READY)
    db = integration_db
    organization = create_organization(db)
    admin, _ = create_member(db, organization, "admin")
    member, _ = create_member(db, organization, "member")
    guest, _ = create_member(
        db, organization, "guest", sponsor_user_id=admin.id,
        expires_at=datetime.now(UTC) + timedelta(days=7),
    )
    no_access, _ = create_member(db, organization, "member")
    department = Department(org_id=organization.id, department_name="Operations")
    group = Group(org_id=organization.id, name="Operations readers")
    db.add_all([department, group])
    db.flush()
    db.add_all([
        GroupMember(org_id=organization.id, group_id=group.id, user_id=member.id),
        GroupAccess(org_id=organization.id, group_id=group.id, department_id=department.id,
                    level=str(AccessLevel.READ)),
    ])
    # A person with no membership anywhere has no organization to bind.
    unbound = User(email="unbound@example.test", username="unbound-person", status="active")
    db.add(unbound)
    # Commit into the outer test transaction so the route's rollback keeps the rows.
    db.commit()
    return db, organization.id, {
        "admin": admin, "member": member, "guest": guest,
        "member_without_group_access": no_access, "unbound": unbound,
    }


def _get_status(db: Session, actor: User):
    application = create_app()
    application.dependency_overrides[get_db] = lambda: db
    application.dependency_overrides[get_current_user] = scoped_override(lambda: actor)
    return TestClient(application).get("/api/system/status")


def _written(db: Session, org_id: UUID) -> tuple[int, int]:
    # Count under one fixed organization binding; each request rebinds the shared session.
    scope_session(db, org_id)
    return (
        db.scalar(select(func.count()).select_from(AuditLog)) or 0,
        db.scalar(select(func.count()).select_from(SecurityEvent)) or 0,
    )


def test_s2_c1_c10_every_role_reads_the_status_and_no_audit_or_security_row_is_written(people):
    db, org_id, actors = people
    before = _written(db, org_id)

    answers = {
        role: _get_status(db, actors[role])
        for role in ("admin", "member", "guest", "member_without_group_access")
    }
    refused = _get_status(db, actors["unbound"])

    for role, response in answers.items():
        assert response.status_code == 200, (role, response.text)
        body = response.json()
        assert [part["key"] for part in body["parts"]] == ["data", "signing_in", "files", "email"]
        assert [part["status"] for part in body["parts"]] == [
            "working", "working", "working", "set_up",
        ]
        assert body["version"] == "0.1.0"
        assert body["checked_at"].endswith("Z")
    assert refused.status_code == 403
    assert refused.json() == {
        "detail": {
            "code": "organization_required",
            "message": "An active organization membership is required",
        },
        "request_id": refused.headers["X-Request-ID"],
    }
    assert _written(db, org_id) == before
