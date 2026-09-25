from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel, ValidationError
from uuid6 import uuid7

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.systems.access.users.schemas import (
    InvitationCreate,
    RoleCreate,
    RoleUpdate,
    UserCreate,
    UserUpdate,
)
from app.systems.sandbox.departments.schemas import DepartmentCreate, DepartmentUpdate
from app.systems.sandbox.fields.schemas import FieldCreate, FieldReorder, FieldUpdate
from app.systems.sandbox.modules.schemas import ModuleCreate, ModuleUpdate
from app.systems.sandbox.records.schemas import RecordCreate, RecordUpdate
from tests.catalog.auth_support import override_catalog_authorization


def _actor() -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid7(),
        identity_kind="internal",
        role_id=uuid7(),
        role=SimpleNamespace(role="admin"),
    )


@pytest.fixture
def client() -> TestClient:
    application = create_app()
    application.dependency_overrides[get_current_user] = _actor
    override_catalog_authorization(application)
    application.dependency_overrides[get_db] = lambda: object()
    with TestClient(application) as test_client:
        yield test_client
    application.dependency_overrides.clear()


REQUEST_SCHEMAS: list[tuple[type[BaseModel], dict[str, Any]]] = [
    (InvitationCreate, {"email": "admin@example.com", "username": "admin"}),
    (DepartmentCreate, {"department_name": "Operations"}),
    (DepartmentUpdate, {"department_name": "Operations"}),
    (ModuleCreate, {"department_id": uuid7(), "module_name": "Customers"}),
    (ModuleUpdate, {"module_name": "Customers"}),
    (
        FieldCreate,
        {"module_id": uuid7(), "name": "Status", "type": "text", "position": 0},
    ),
    (FieldUpdate, {"name": "Status"}),
    (FieldReorder, {"field_ids": [uuid7()]}),
    (RecordCreate, {"module_id": uuid7(), "data": {"dynamic-field": "value"}}),
    (RecordUpdate, {"data": {"dynamic-field": "value"}}),
    (RoleCreate, {"role": "editor", "permissions": {"records.read": True}}),
    (RoleUpdate, {"role": "editor"}),
    (UserCreate, {"email": "member@example.com", "username": "member"}),
    (UserUpdate, {"username": "member"}),
]


@pytest.mark.parametrize(("schema", "payload"), REQUEST_SCHEMAS)
def test_write_schemas_accept_declared_inputs_and_reject_unknown_top_level_fields(
    schema: type[BaseModel], payload: dict[str, Any]
) -> None:
    schema.model_validate(payload)

    with pytest.raises(ValidationError):
        schema.model_validate({**payload, "unexpected": True})


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("post", "/api/auth/invitations", {"email": "admin@example.com", "username": "admin"}),
        ("post", "/api/departments", {"department_name": "Operations"}),
        ("patch", f"/api/departments/{uuid7()}", {"department_name": "Operations"}),
        ("post", "/api/modules", {"department_id": str(uuid7()), "module_name": "Customers"}),
        ("patch", f"/api/modules/{uuid7()}", {"module_name": "Customers"}),
        (
            "post",
            "/api/fields",
            {"module_id": str(uuid7()), "name": "Status", "type": "text", "position": 0},
        ),
        ("patch", f"/api/fields/{uuid7()}", {"name": "Status"}),
        ("post", f"/api/modules/{uuid7()}/fields/reorder", {"field_ids": [str(uuid7())]}),
        ("post", "/api/records", {"module_id": str(uuid7()), "data": {"dynamic": "value"}}),
        ("patch", f"/api/records/{uuid7()}", {"data": {"dynamic": "value"}}),
        ("post", "/api/roles", {"role": "editor", "permissions": {"records.read": True}}),
        ("patch", f"/api/roles/{uuid7()}", {"role": "editor"}),
        ("post", "/api/users", {"email": "member@example.com", "username": "member"}),
        ("patch", f"/api/users/{uuid7()}", {"username": "member"}),
    ],
)
def test_unknown_write_fields_return_fastapi_422(
    client: TestClient, method: str, path: str, payload: dict[str, Any]
) -> None:
    response = getattr(client, method)(path, json={**payload, "unexpected": True})

    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"][-1] == "unexpected"
