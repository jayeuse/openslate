from fastapi.testclient import TestClient
from uuid6 import uuid7

from app.main import app, create_app
from app.systems.access.users.permissions import ALL_CAPABILITIES
from tests.rbac.support import _client, make_role, make_user


def test_query_requires_authentication() -> None:
    with TestClient(app) as client:
        response = client.post("/api/records/query", json={})
    assert response.status_code == 401


def test_grouped_and_aggregate_queries_require_authentication() -> None:
    with TestClient(app) as client:
        grouped = client.post("/api/records/grouped-query", json={})
        aggregate = client.post("/api/records/aggregate-query", json={})
    assert grouped.status_code == 401
    assert aggregate.status_code == 401


def test_custom_role_cannot_export_and_writer_cannot_query() -> None:
    application = create_app()
    custom = make_user(
        "custom-exporter",
        role=make_role("custom-exporter", {key: True for key in ALL_CAPABILITIES}),
    )
    query = {"module_id": str(uuid7()), "definition": {}}

    with _client(application, custom) as client:
        response = client.post("/api/records/export", json=query)
    assert response.status_code == 403

    writer = make_user("query-writer", permissions={"records.write": True})
    with _client(application, writer) as client:
        response = client.post("/api/records/query", json=query)
    assert response.status_code == 403
