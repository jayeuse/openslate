from fastapi.testclient import TestClient

from app.main import app


def test_query_requires_authentication() -> None:
    with TestClient(app) as client:
        response = client.post("/api/records/query", json={})
    assert response.status_code == 401


def test_custom_role_cannot_export_and_writer_cannot_query() -> None:
    from uuid6 import uuid7

    from app.common.dependencies import get_current_user
    from app.systems.users.models import Role, User
    from app.systems.users.permissions import ALL_CAPABILITIES

    custom = User(
        id=uuid7(), role=Role(role="custom", permissions={key: True for key in ALL_CAPABILITIES})
    )
    app.dependency_overrides[get_current_user] = lambda: custom
    try:
        with TestClient(app) as client:
            response = client.post("/api/records/export", json={})
            assert response.status_code == 403
            custom.role.permissions = {"records.write": True}
            response = client.post("/api/records/query", json={})
            assert response.status_code == 403
    finally:
        app.dependency_overrides.pop(get_current_user, None)
