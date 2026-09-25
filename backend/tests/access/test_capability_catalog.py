"""HTTP contract for the administrator-only access capability catalog."""

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.common.dependencies import get_current_user
from app.main import create_app

EXPECTED_CAPABILITY_IDS = [
    "departments.read",
    "departments.write",
    "modules.read",
    "modules.write",
    "fields.read",
    "fields.write",
    "records.read",
    "records.write",
    "relationships.read",
    "relationships.write",
]


def _application(role: str) -> FastAPI:
    application: FastAPI = create_app()
    application.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        identity_kind="internal",
        role=SimpleNamespace(role=role)
    )
    return application


def test_capability_catalog_is_private_complete_and_literal_admin_only() -> None:
    application = _application("admin")
    response = TestClient(application).get("/api/access/capabilities")

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    items = response.json()["items"]
    assert [item["id"] for item in items] == EXPECTED_CAPABILITY_IDS
    assert all(
        set(item) == {"id", "label", "description", "group"}
        and all(isinstance(item[field], str) and item[field] for field in item)
        for item in items
    )
    openapi = application.openapi()
    assert openapi["components"]["schemas"]["CapabilityItem"]["properties"]["id"] == {
        "$ref": "#/components/schemas/Capability"
    }
    assert openapi["components"]["schemas"]["Capability"]["enum"] == EXPECTED_CAPABILITY_IDS

    denied = TestClient(_application("custom")).get("/api/access/capabilities")
    assert denied.status_code == 403
