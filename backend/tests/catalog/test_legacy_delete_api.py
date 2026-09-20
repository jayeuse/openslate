from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.main import create_app

_DELETE_ROUTES = (
    ("/api/departments/{id}", "Use Close to close this department"),
    ("/api/modules/{id}", "Use Close to close this module"),
    ("/api/fields/{id}", "Use Close to close this field"),
)
_OPENAPI_DELETE_PATHS = (
    "/api/departments/{department_id}",
    "/api/modules/{module_id}",
    "/api/fields/{field_id}",
)


def _client(database: Session, actor: object | None = None) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_db] = lambda: database
    if actor is not None:
        app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


@pytest.mark.parametrize(("route_template", "message"), _DELETE_ROUTES)
def test_registered_delete_requires_lifecycle_close(
    route_template: str, message: str
) -> None:
    database = Mock(spec=Session)
    target_id = uuid7()
    database.get.return_value = SimpleNamespace(id=target_id)
    actor = SimpleNamespace(role=SimpleNamespace(role="admin"))

    response = _client(database, actor).delete(route_template.format(id=target_id))

    assert response.status_code == 409
    assert response.json() == {
        "detail": {"code": "close_required", "message": message}
    }
    database.flush.assert_not_called()
    database.add.assert_not_called()
    database.delete.assert_not_called()
    database.commit.assert_not_called()


@pytest.mark.parametrize("route_template", [route for route, _message in _DELETE_ROUTES])
def test_registered_delete_returns_not_found_without_a_target(route_template: str) -> None:
    database = Mock(spec=Session)
    database.get.return_value = None
    actor = SimpleNamespace(role=SimpleNamespace(role="admin"))

    response = _client(database, actor).delete(route_template.format(id=uuid7()))

    assert response.status_code == 404
    assert response.json()["detail"].endswith("not found")
    database.commit.assert_not_called()


@pytest.mark.parametrize("route_template", [route for route, _message in _DELETE_ROUTES])
def test_registered_delete_requires_authentication(route_template: str) -> None:
    database = Mock(spec=Session)

    response = _client(database).delete(route_template.format(id=uuid7()))

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid authentication credentials"}
    assert response.headers["www-authenticate"] == "Bearer"
    database.get.assert_not_called()


@pytest.mark.parametrize("route_template", [route for route, _message in _DELETE_ROUTES])
def test_registered_delete_requires_write_capability(route_template: str) -> None:
    database = Mock(spec=Session)
    actor = SimpleNamespace(role=SimpleNamespace(role="staff", permissions={}))

    response = _client(database, actor).delete(route_template.format(id=uuid7()))

    assert response.status_code == 403
    assert response.json() == {"detail": "Forbidden"}
    database.get.assert_not_called()


def test_registered_delete_openapi_documents_conflict_without_204() -> None:
    database = Mock(spec=Session)
    actor = SimpleNamespace(role=SimpleNamespace(role="admin"))
    paths = _client(database, actor).get("/openapi.json").json()["paths"]

    for route_template in _OPENAPI_DELETE_PATHS:
        responses = paths[route_template]["delete"]["responses"]
        assert "409" in responses
        assert "204" not in responses
