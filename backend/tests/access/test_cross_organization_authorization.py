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
