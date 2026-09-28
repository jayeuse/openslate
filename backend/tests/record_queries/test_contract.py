from fastapi.testclient import TestClient
from uuid6 import uuid7

from app.main import app, create_app
from tests.rbac.support import _client, make_user


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


def test_member_cannot_export_records() -> None:
    application = create_app()
    member = make_user("member-exporter", role="member")
    query = {"module_id": str(uuid7()), "definition": {}}

    with _client(application, member) as client:
        response = client.post("/api/records/export", json=query)
    assert response.status_code == 403
