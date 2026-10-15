"""HTTP request admission must not reach persistence for forbidden operations."""

from unittest.mock import Mock
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import UserRole
from app.systems.platform.files.router import router
from tests.users.user_support import local_user


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router, prefix="/api")
    actor, membership = local_user(UserRole.GUEST)
    database = Mock()
    database.dirty = set()
    database.scalars.return_value.all.return_value = [membership]
    app.dependency_overrides[get_current_user] = lambda: actor
    app.dependency_overrides[get_db] = lambda: database
    with TestClient(app) as client:
        yield client


def test_non_admin_cannot_list_logos(client):
    for purpose in ["workspace_logo"]:
        response = client.get("/api/files", params={"purpose": purpose})
        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "forbidden"


def test_guest_cannot_reserve_attachment(client):
    response = client.post(
        "/api/files",
        json={
            "purpose": "record_attachment",
            "record_id": str(uuid4()),
            "filename": "a.pdf",
            "expected_size": 10,
        },
    )
    assert response.status_code == 403


def test_clients_cannot_submit_file_state_or_storage_identity(client):
    response = client.post(
        "/api/files",
        json={
            "purpose": "library_document",
            "department_id": str(uuid4()),
            "filename": "a.pdf",
            "expected_size": 10,
            "state": "ready",
            "object_key": "chosen",
        },
    )
    assert response.status_code == 422
    assert {error["loc"][-1] for error in response.json()["detail"]} == {"state", "object_key"}
