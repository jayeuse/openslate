"""Routes retired with roles, rules and service identities stay unmounted (S3-9)."""

import pytest
from fastapi.testclient import TestClient
from uuid6 import uuid7

from app.main import app, create_app
from app.systems.access.users.models import UserRole
from tests.rbac.support import _client, make_user

_ID = str(uuid7())

REMOVED_ROUTES: tuple[tuple[str, str], ...] = (
    ("/api/roles", "GET"),
    ("/api/roles", "POST"),
    (f"/api/roles/{_ID}", "GET"),
    (f"/api/roles/{_ID}", "PATCH"),
    (f"/api/roles/{_ID}", "DELETE"),
    (f"/api/roles/{_ID}/restore", "POST"),
    ("/api/access/service-identities", "GET"),
    ("/api/access/service-identities", "POST"),
    (f"/api/access/service-identities/{_ID}", "PATCH"),
    (f"/api/access/service-identities/{_ID}/restore", "POST"),
    ("/api/access/rules", "GET"),
    ("/api/access/rules", "POST"),
    (f"/api/access/rules/{_ID}", "PATCH"),
    ("/api/access/rules/impact-preview", "POST"),
    ("/api/access/rules/apply", "POST"),
    ("/api/access/checks", "POST"),
    ("/api/access/capabilities", "GET"),
    ("/api/access/defaults", "GET"),
    ("/api/access/defaults", "PATCH"),
    (f"/api/boards/{_ID}/grant-roles", "GET"),
)

# The retired chooser path now falls into the report detail route, whose UUID
# parameter rejects it; it can never reach a dedicated handler again.
SHADOWED_ROUTES: tuple[tuple[str, str], ...] = (("/api/reports/audience-roles", "GET"),)

_REMOVED_PREFIXES = (
    "/api/roles",
    "/api/access/service-identities",
    "/api/access/rules",
    "/api/access/checks",
    "/api/access/capabilities",
    "/api/access/defaults",
    "/api/reports/audience-roles",
)


def test_removed_routes_are_absent_from_openapi() -> None:
    paths = app.openapi()["paths"]

    leftovers = sorted(
        path
        for path in paths
        if path.startswith(_REMOVED_PREFIXES) or path.endswith("/grant-roles")
    )

    assert leftovers == []


@pytest.mark.parametrize(("url", "method"), REMOVED_ROUTES)
def test_removed_route_is_not_served(url: str, method: str) -> None:
    response = TestClient(app).request(method, url)

    assert response.status_code in {404, 405}


@pytest.mark.parametrize(("url", "method"), SHADOWED_ROUTES)
def test_shadowed_removed_route_is_rejected_as_a_malformed_id(url: str, method: str) -> None:
    member = make_user("member", role=UserRole.MEMBER)

    response = _client(create_app(), member).request(method, url)

    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["path", "report_id"]
