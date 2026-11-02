"""S1: every error JSON body carries the response's own request ID beside an unchanged detail."""

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app.main import create_app


class _CountBody(BaseModel):
    count: int


def _client() -> TestClient:
    app = create_app()

    @app.get("/api/test-rate-limited")
    def test_rate_limited() -> None:
        raise HTTPException(429, detail="Too many attempts", headers={"Retry-After": "7"})

    @app.get("/api/test-not-modified")
    def test_not_modified() -> None:
        raise HTTPException(304)

    @app.post("/api/test-validation")
    def test_validation(body: _CountBody) -> dict[str, int]:
        return {"count": body.count}

    return TestClient(app)


@pytest.mark.parametrize(
    ("method", "path", "status", "detail"),
    [
        # Raised by the real authentication dependency before any database use.
        ("GET", "/api/auth/me", 401, "Invalid authentication credentials"),
        # The /api branch of the routing 404.
        ("GET", "/api/missing", 404, "Not Found"),
        # Routing 405 with no static site goes through the same handler.
        ("POST", "/api/health", 405, "Method Not Allowed"),
        ("GET", "/api/test-rate-limited", 429, "Too many attempts"),
    ],
)
def test_s1_c1_raised_http_errors_carry_the_header_request_id(method, path, status, detail):
    response = _client().request(method, path)

    assert response.status_code == status
    assert response.json() == {"detail": detail, "request_id": response.headers["X-Request-ID"]}


def test_s1_c1_raised_errors_keep_their_headers():
    response = _client().get("/api/test-rate-limited")

    assert response.headers["Retry-After"] == "7"
    assert response.headers["Cache-Control"] == "no-store"


def test_s1_c1_a_status_that_cannot_carry_a_body_stays_empty():
    response = _client().get("/api/test-not-modified")

    assert response.status_code == 304
    assert response.content == b""
    assert len(response.headers["X-Request-ID"]) == 36


def test_s1_c1_schema_validation_422_keeps_the_exact_detail_list_and_adds_the_request_id():
    response = _client().post("/api/test-validation", json={"count": "many"})

    assert response.status_code == 422
    assert response.json() == {
        "detail": [
            {
                "type": "int_parsing",
                "loc": ["body", "count"],
                "msg": "Input should be a valid integer, unable to parse string as an integer",
                "input": "many",
            }
        ],
        "request_id": response.headers["X-Request-ID"],
    }
