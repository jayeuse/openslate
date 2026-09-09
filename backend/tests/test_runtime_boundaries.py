import asyncio
from unittest.mock import Mock

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as SQLAlchemyTimeoutError

from app.core.config import Settings
from app.core.database import session as database_session
from app.main import _read_bounded_body, create_app


@pytest.fixture(autouse=True)
def clean_engine_cache():
    database_session.get_engine.cache_clear()
    yield
    database_session.get_engine.cache_clear()


def test_every_application_response_has_a_server_generated_request_id() -> None:
    app = create_app()
    @app.get("/api/test-unhandled-error")
    def test_unhandled_error() -> None:
        raise RuntimeError("sensitive internal error")

    client = TestClient(app)

    health = client.get("/api/health", headers={"X-Request-ID": "forged"})
    missing = client.get("/api/missing")
    unexpected = client.get("/api/test-unhandled-error")

    assert health.status_code == 200
    assert health.headers["X-Request-ID"] != "forged"
    assert len(health.headers["X-Request-ID"]) == 36
    assert missing.status_code == 404
    assert len(missing.headers["X-Request-ID"]) == 36
    assert unexpected.status_code == 500
    assert len(unexpected.headers["X-Request-ID"]) == 36
    assert "sensitive internal error" not in unexpected.text


def test_declared_request_body_over_limit_is_rejected_with_a_diagnostic_id() -> None:
    app = create_app()
    client = TestClient(app)

    response = client.post(
        "/api/auth/invitations/accept",
        content=b"x",
        headers={"Content-Length": str(1024 * 1024 + 1)},
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Request body is too large"}
    assert len(response.headers["X-Request-ID"]) == 36


def test_database_availability_failure_is_mapped_to_safe_503_with_diagnostic_id() -> None:
    app = create_app()

    @app.get("/api/test-database-unavailable")
    def test_database_unavailable() -> None:
        raise OperationalError("SELECT 1", {}, RuntimeError("private database detail"))

    response = TestClient(app).get("/api/test-database-unavailable")

    assert response.status_code == 503
    assert response.json() == {"detail": "Database unavailable"}
    assert len(response.headers["X-Request-ID"]) == 36
    assert "private database detail" not in response.text


def test_actual_request_body_over_limit_is_rejected_despite_false_content_length() -> None:
    app = create_app()
    client = TestClient(app)

    response = client.post(
        "/api/auth/invitations/accept",
        content=b"x" * (1024 * 1024 + 1),
        headers={"Content-Length": "1"},
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Request body is too large"}


def test_incremental_body_limit_stops_reading_after_the_first_overflow() -> None:
    seen: list[bytes] = []

    class StreamingRequest:
        async def stream(self):
            for chunk in (b"a" * 3, b"b" * 3, b"never-read"):
                seen.append(chunk)
                yield chunk

    request = StreamingRequest()

    assert asyncio.run(_read_bounded_body(request, 5)) is False
    assert seen == [b"a" * 3, b"b" * 3]


def test_readiness_returns_generic_status_and_disables_caching(monkeypatch) -> None:
    import app.main as main

    monkeypatch.setattr(main, "is_database_ready", lambda: False)
    response = TestClient(create_app()).get("/api/ready")

    assert response.status_code == 503
    assert response.json() == {"status": "not_ready"}
    assert response.headers["Cache-Control"] == "no-store"


def test_runtime_engine_uses_bounded_connection_settings(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def create_engine_spy(*args: object, **kwargs: object):
        captured.update(kwargs)
        return Mock(spec=Engine)

    settings = Settings(
        database_url="postgresql+psycopg://test:test@localhost/test",
        _env_file=None,
    )
    monkeypatch.setattr(database_session, "get_settings", lambda: settings)
    monkeypatch.setattr(database_session, "create_engine", create_engine_spy)
    database_session.get_engine.cache_clear()

    database_session.get_engine()

    assert captured["pool_size"] == 5
    assert captured["max_overflow"] == 5
    assert captured["pool_timeout"] == 5
    assert captured["connect_args"] == {
        "connect_timeout": 3,
        "options": "-c statement_timeout=15000",
    }


@pytest.mark.parametrize(
    "error",
    [
        OperationalError("SELECT 1", {}, RuntimeError("database unavailable")),
        SQLAlchemyTimeoutError("database checkout timed out"),
    ],
)
def test_database_session_rolls_back_availability_error_before_propagating(
    monkeypatch,
    error: Exception,
) -> None:
    session = Mock()
    session.info = {}
    session.__enter__ = Mock(return_value=session)
    session.__exit__ = Mock(return_value=False)
    monkeypatch.setattr(database_session, "AuditSession", lambda *args: session)
    monkeypatch.setattr(database_session, "get_engine", lambda: Mock())
    request = Mock(spec=Request)
    request.state.request_context = Mock(
        performed_by=None,
        request_id=Mock(),
        method="GET",
        path="/api/test",
    )

    generator = database_session.get_db(request)
    next(generator)

    with pytest.raises(type(error)):
        generator.throw(error)

    session.rollback.assert_called_once_with()
