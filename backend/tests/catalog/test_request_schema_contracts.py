from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel, ValidationError
from uuid6 import uuid7

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.systems.access.policy.schemas import (
    GroupAccessReplace,
    GroupCreate,
    GroupMembersReplace,
    GroupUpdate,
)
from app.systems.access.users.schemas import (
    InvitationCreate,
    UserCreate,
    UserUpdate,
)
from app.systems.sandbox.records.schemas import RecordCreate, RecordUpdate
from tests.catalog.auth_support import override_catalog_authorization
from tests.rbac.support import make_user

# Fixed, so parametrized test IDs are the same in every process.
_PATH_ID = "0190a000-0000-7000-8000-000000000001"


def _actor() -> object:
    return make_user("schema-admin")


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
    (RecordCreate, {"module_id": uuid7(), "data": {"dynamic-field": "value"}}),
    (RecordUpdate, {"data": {"dynamic-field": "value"}}),
    (GroupCreate, {"name": "Inventory"}),
    (GroupAccessReplace, {"access": []}),
    (GroupMembersReplace, {"member_ids": []}),
    (GroupUpdate, {"name": "Inventory"}),
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


@pytest.mark.integration
@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("post", "/api/auth/invitations", {"email": "admin@example.com", "username": "admin"}),
        ("post", "/api/records", {"module_id": _PATH_ID, "data": {"dynamic": "value"}}),
        ("patch", f"/api/records/{_PATH_ID}", {"data": {"dynamic": "value"}}),
        ("post", "/api/access/groups", {"name": "Inventory"}),
        ("put", f"/api/access/groups/{_PATH_ID}/access", {"access": []}),
        ("put", f"/api/access/groups/{_PATH_ID}/members", {"member_ids": []}),
        ("post", "/api/users", {"email": "member@example.com", "username": "member"}),
        ("patch", f"/api/users/{_PATH_ID}", {"username": "member"}),
    ],
)
def test_unknown_write_fields_return_fastapi_422(
    client: TestClient, method: str, path: str, payload: dict[str, Any]
) -> None:
    response = getattr(client, method)(path, json={**payload, "unexpected": True})

    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"][-1] == "unexpected"
