"""An administrator of one organization has no administrator power in another (S07)."""

import re
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import get_current_user
from app.common.dependencies.auth import require_admin
from app.core.database.session import get_db
from app.main import create_app
from app.systems.access.users.models import User
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.conftest import create_member, create_organization
from tests.organization_scope_support import scoped_override

pytestmark = pytest.mark.integration


def _depends_on(dependant: Dependant, target: Any) -> bool:
    return any(
        dependency.call is target or _depends_on(dependency, target)
        for dependency in dependant.dependencies
    )


def _administrator_routes(application: FastAPI) -> list[tuple[str, str]]:
    """Every route that requires an administrator, with placeholder path values.

    Dependencies are resolved before path and body validation, so a refused
    administrator is answered with 403 whatever the placeholders are.
    """

    routes = set()
    for included in application.routes:
        # Included routers expose their routes with the full prefixed path.
        contexts = getattr(included, "effective_route_contexts", None)
        for context in contexts() if contexts is not None else ():
            route = context.original_route
            if isinstance(route, APIRoute) and _depends_on(route.dependant, require_admin):
                path = re.sub(r"\{[^}/]+\}", str(uuid7()), context.path)
                routes.update((method, path) for method in route.methods - {"HEAD", "OPTIONS"})
    return sorted(routes)


@pytest.fixture
def two_organizations(
    integration_db: Session,
) -> tuple[Session, User, WorkspaceProfile, WorkspaceProfile]:
    db = integration_db
    home = create_organization(db)
    visited = create_organization(db)
    sponsor, _ = create_member(db, visited, "member")
    actor, _ = create_member(db, home, "admin")
    create_member(
        db, visited, "guest", user=actor, sponsor_user_id=sponsor.id,
        expires_at=datetime.now(UTC) + timedelta(days=7),
    )
    # Commit into the test's outer transaction so a refused request's rollback keeps it.
    db.commit()
    return db, actor, home, visited


def _client(db: Session, actor: User, organization: WorkspaceProfile) -> TestClient:
    application = create_app()
    application.dependency_overrides[get_db] = lambda: db
    application.dependency_overrides[get_current_user] = scoped_override(
        lambda: actor, org_id=organization.id
    )
    return TestClient(application)


def test_every_administrator_route_refuses_an_administrator_of_another_organization(
    two_organizations: tuple[Session, User, WorkspaceProfile, WorkspaceProfile],
) -> None:
    db, actor, _home, visited = two_organizations
    routes = _administrator_routes(create_app())
    assert len(routes) > 20, routes
    with _client(db, actor, visited) as client:
        answered = {(method, path): client.request(method, path).status_code
                    for method, path in routes}
    assert {route: code for route, code in answered.items() if code != 403} == {}


def test_the_same_account_still_administers_its_own_organization(
    two_organizations: tuple[Session, User, WorkspaceProfile, WorkspaceProfile],
) -> None:
    db, actor, home, visited = two_organizations
    path = "/api/users?limit=1&offset=0"
    with _client(db, actor, home) as client:
        assert client.get(path).status_code == 200
    with _client(db, actor, visited) as client:
        assert client.get(path).status_code == 403


def test_account_rows_are_visible_only_for_people_of_the_bound_organization(
    two_organizations: tuple[Session, User, WorkspaceProfile, WorkspaceProfile],
) -> None:
    db, actor, home, visited = two_organizations
    neighbour, _ = create_member(db, home, "member")
    stranger, _ = create_member(db, visited, "member")
    for person in (neighbour, stranger):
        append_security_event(db, SecurityEventIngestRequest(
            event_type="identity.sign_in_failure", outcome=SecurityEventOutcome.DENIED,
            source="tests", operation_id=uuid7(), actor_id=person.id, subject_id=person.id,
        ))
        person.display_name = f"Renamed {person.id.hex[:8]}"  # an account audit row
    db.commit()
    with _client(db, actor, home) as client:
        events = client.get(f"/api/security-events?person_id={neighbour.id}&limit=50")
        hidden_events = client.get(f"/api/security-events?person_id={stranger.id}&limit=50")
        audits = client.get(f"/api/audit-logs?entity_id={neighbour.id}&limit=50")
        hidden_audits = client.get(f"/api/audit-logs?entity_id={stranger.id}&limit=50")
    assert events.status_code == 200 and events.json()["items"], events.text
    assert hidden_events.status_code == 200 and hidden_events.json()["items"] == []
    assert audits.status_code == 200 and audits.json()["items"], audits.text
    assert hidden_audits.status_code == 200 and hidden_audits.json()["items"] == []


def test_account_changes_refuse_a_person_who_belongs_to_another_organization(
    two_organizations: tuple[Session, User, WorkspaceProfile, WorkspaceProfile],
) -> None:
    db, actor, home, visited = two_organizations
    shared, _ = create_member(db, home, "member")
    create_member(db, visited, "admin", user=shared)
    db.commit()
    with _client(db, actor, home) as client:
        disabled = client.patch(f"/api/users/{shared.id}", json={"status": "disabled"})
        deleted = client.delete(f"/api/users/{shared.id}")
    assert disabled.status_code == 409, disabled.text
    assert deleted.status_code == 409, deleted.text
    db.expire_all()
    assert shared.status == "active" and shared.is_deleted is False
