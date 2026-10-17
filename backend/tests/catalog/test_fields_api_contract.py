from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database import get_db
from app.systems.sandbox.departments.router import router as departments_router
from app.systems.sandbox.fields.router import router as fields_router
from app.systems.sandbox.modules.router import router as modules_router
from app.systems.sandbox.records.router import router as records_router
from tests.catalog.auth_support import override_catalog_authorization

SCHEMA_ROUTES = {
    "/api/departments": {"get"},
    "/api/departments/{department_id}": {"get"},
    "/api/modules": {"get"},
    "/api/modules/{module_id}": {"get"},
    "/api/fields": {"get"},
    "/api/fields/{field_id}": {"get"},
}
REMOVED_SCHEMA_PATHS = (
    "/api/departments/{department_id}/restore",
    "/api/modules/{module_id}/restore",
    "/api/modules/{module_id}/schema/accept",
    "/api/fields/{field_id}/restore",
    "/api/modules/{module_id}/fields/reorder",
)


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("post", "/api/departments", {"department_name": "Operations"}),
        ("patch", "/api/departments/{id}", {"department_name": "Operations"}),
        ("delete", "/api/departments/{id}", None),
        ("post", "/api/departments/{id}/restore", None),
        ("post", "/api/modules", {"department_id": "{id}", "module_name": "Assets"}),
        ("patch", "/api/modules/{id}", {"module_name": "Assets"}),
        ("delete", "/api/modules/{id}", None),
        ("post", "/api/modules/{id}/restore", None),
        ("post", "/api/modules/{id}/schema/accept", None),
        ("post", "/api/fields", {"module_id": "{id}", "name": "Title", "type": "text"}),
        ("patch", "/api/fields/{id}", {"name": "Title"}),
        ("delete", "/api/fields/{id}", None),
        ("post", "/api/fields/{id}/restore", None),
    ],
)
def test_removed_schema_write_routes_are_not_served(method, path, body) -> None:
    db = Mock(spec=Session)
    identifier = str(uuid7())
    payload = (
        None
        if body is None
        else {
            key: (
                [identifier]
                if isinstance(value, list)
                else identifier
                if value == "{id}"
                else value
            )
            for key, value in body.items()
        }
    )

    response = _catalog_rejection_client(db).request(
        method.upper(), path.replace("{id}", identifier), json=payload
    )

    assert response.status_code in {404, 405}
    db.add.assert_not_called()
    db.commit.assert_not_called()


@pytest.mark.parametrize("payload", [{}, {"data": None}])
def test_empty_or_null_record_patch_rejected_before_database_lookup(payload) -> None:
    db = Mock(spec=Session)
    response = _catalog_rejection_client(db).patch(f"/api/records/{uuid7()}", json=payload)
    assert response.status_code == 422
    assert response.json()["detail"] == "At least one non-null field is required"
    db.get.assert_not_called()
    db.commit.assert_not_called()


@pytest.mark.parametrize(
    "resource,singular",
    [
        ("fields", "Field"),
        ("records", "Record"),
        ("modules", "Module"),
        ("departments", "Department"),
    ],
)
def test_missing_catalog_resource_read_returns_404(resource, singular) -> None:
    db = Mock(spec=Session)
    db.get.return_value = None
    db.scalar.return_value = None
    response = _catalog_rejection_client(db).get(f"/api/{resource}/{uuid7()}")
    assert response.status_code == 404
    assert response.json() == {"detail": f"{singular} not found"}
    db.commit.assert_not_called()


def test_missing_record_has_consistent_mutation_404() -> None:
    db = Mock(spec=Session)
    db.get.return_value = None
    client = _catalog_rejection_client(db)
    path = f"/api/records/{uuid7()}"
    for response in (client.delete(path), client.post(f"{path}/restore")):
        assert response.status_code == 404
        assert response.json() == {"detail": "Record not found"}
    db.commit.assert_not_called()


def test_record_create_rejects_missing_active_module_before_writes() -> None:
    db = Mock(spec=Session)
    db.info = {}
    # The module lock reads the module; a missing one is refused before any write.
    db.get.return_value = None
    db.scalar.return_value = None
    client = _catalog_rejection_client(db)
    response = client.post("/api/records", json={"module_id": str(uuid7()), "data": {}})
    assert response.status_code == 409
    assert response.json()["detail"] == "Module is not active"
    db.add.assert_not_called()
    db.commit.assert_not_called()


def _catalog_rejection_client(db: Session) -> TestClient:
    app = FastAPI()
    for router in (fields_router, records_router, modules_router, departments_router):
        app.include_router(router, prefix="/api")
    override_catalog_authorization(app, db)
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def test_closed_record_rejects_patch() -> None:
    db = Mock(spec=Session)
    db.get.return_value = SimpleNamespace(is_deleted=True, module_id=uuid7())
    response = _catalog_rejection_client(db).patch(f"/api/records/{uuid7()}", json={"data": {}})
    assert response.status_code == 409
    assert response.json()["detail"] == "Record is deleted"
    db.commit.assert_not_called()
