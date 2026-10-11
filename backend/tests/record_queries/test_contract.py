"""The record query routes refuse a request without credentials before any work."""

from fastapi.testclient import TestClient

from tests.route_app_support import route_app


def test_query_requires_authentication() -> None:
    with TestClient(route_app()) as client:
        response = client.post("/api/records/query", json={})
    assert response.status_code == 401


def test_grouped_and_aggregate_queries_require_authentication() -> None:
    with TestClient(route_app()) as client:
        grouped = client.post("/api/records/grouped-query", json={})
        aggregate = client.post("/api/records/aggregate-query", json={})
    assert grouped.status_code == 401
    assert aggregate.status_code == 401
