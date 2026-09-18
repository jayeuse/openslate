from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.sandbox.departments.router import router as departments_router
from app.systems.sandbox.fields.router import (
    module_fields_router,
)
from app.systems.sandbox.fields.router import router as fields_router
from app.systems.sandbox.modules.router import router as modules_router
from app.systems.sandbox.records.router import router as records_router


def test_routers_expose_crud_restore_and_reorder_contract() -> None:
    app = FastAPI()
    app.include_router(fields_router, prefix="/api")
    app.include_router(module_fields_router, prefix="/api")
    app.include_router(records_router, prefix="/api")
    client = TestClient(app)

    paths = client.get("/openapi.json").json()["paths"]
    assert set(paths["/api/fields"]) == {"get", "post"}
    assert set(paths["/api/fields/{field_id}"]) == {"get", "patch", "delete"}
    assert set(paths["/api/fields/{field_id}/restore"]) == {"post"}
    assert set(paths["/api/modules/{module_id}/fields/reorder"]) == {"post"}
    assert set(paths["/api/records"]) == {"get", "post"}
    assert set(paths["/api/records/{record_id}"]) == {"get", "patch", "delete"}
    assert set(paths["/api/records/{record_id}/restore"]) == {"post"}


@pytest.mark.parametrize("resource", ["fields", "records", "modules", "departments"])
@pytest.mark.parametrize("payload", [{}, {"module_id": None}])
def test_empty_or_null_catalog_patch_rejected_before_database_lookup(resource, payload) -> None:
    db = Mock(spec=Session)
    client = _catalog_rejection_client(db)
    # Use a declared field for each resource so the route enforces null rejection.
    null_keys = {
        "fields": "name",
        "records": "data",
        "modules": "module_name",
        "departments": "department_name",
    }
    body = {} if not payload else {null_keys[resource]: None}
    response = client.patch(f"/api/{resource}/{uuid7()}", json=body)
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
def test_missing_catalog_resource_has_consistent_read_and_mutation_404(resource, singular) -> None:
    db = Mock(spec=Session)
    db.get.return_value = None
    client = _catalog_rejection_client(db)
    path = f"/api/{resource}/{uuid7()}"
    for response in (client.get(path), client.delete(path), client.post(f"{path}/restore")):
        assert response.status_code == 404
        assert response.json() == {"detail": f"{singular} not found"}
    db.commit.assert_not_called()


@pytest.mark.parametrize("resource", ["fields", "records"])
def test_child_create_rejects_missing_active_module_before_writes(resource) -> None:
    db = Mock(spec=Session)
    db.scalar.return_value = None
    client = _catalog_rejection_client(db)
    body = {"module_id": str(uuid7())}
    body.update(
        {"name": "Title", "type": "text", "position": 0} if resource == "fields" else {"data": {}}
    )
    response = client.post(f"/api/{resource}", json=body)
    assert response.status_code == 409
    assert response.json()["detail"] == "Module is not active"
    db.add.assert_not_called()
    db.commit.assert_not_called()


def _catalog_rejection_client(db: Session) -> TestClient:
    app = FastAPI()
    for router in (fields_router, records_router, modules_router, departments_router):
        app.include_router(router, prefix="/api")
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=None, role=SimpleNamespace(role="admin")
    )
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


@pytest.mark.parametrize(
    "resource,payload,singular",
    [
        ("fields", {"name": "Renamed"}, "Field"),
        ("records", {"data": {}}, "Record"),
        ("modules", {"module_name": "Renamed"}, "Module"),
        ("departments", {"department_name": "Renamed"}, "Department"),
    ],
)
def test_closed_catalog_resource_rejects_patch(resource, payload, singular) -> None:
    db = Mock(spec=Session)
    db.get.return_value = SimpleNamespace(is_deleted=True)
    response = _catalog_rejection_client(db).patch(f"/api/{resource}/{uuid7()}", json=payload)
    assert response.status_code == 409
    assert response.json()["detail"] == f"{singular} is deleted"
    db.commit.assert_not_called()


@pytest.mark.parametrize(
    "resource,singular",
    [
        ("fields", "Field"),
        ("modules", "Module"),
        ("departments", "Department"),
    ],
)
def test_active_catalog_resource_cannot_be_restored(resource, singular) -> None:
    db = Mock(spec=Session)
    db.get.return_value = SimpleNamespace(is_deleted=False)
    response = _catalog_rejection_client(db).post(f"/api/{resource}/{uuid7()}/restore")
    assert response.status_code == 409
    assert response.json()["detail"] == f"{singular} is not deleted"
    db.commit.assert_not_called()
