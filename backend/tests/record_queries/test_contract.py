import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.mark.integration
def test_query_requires_authentication() -> None:
    with TestClient(app) as client:
        response = client.post("/api/records/query", json={})
    assert response.status_code == 401


@pytest.mark.integration
def test_grouped_and_aggregate_queries_require_authentication() -> None:
    with TestClient(app) as client:
        grouped = client.post("/api/records/grouped-query", json={})
        aggregate = client.post("/api/records/aggregate-query", json={})
    assert grouped.status_code == 401
    assert aggregate.status_code == 401
