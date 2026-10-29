import asyncio
import os
from secrets import token_urlsafe
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as SQLAlchemyTimeoutError

from app.core.config import Settings
from app.core.database import session as database_session
from app.core.middleware.file_transfers import read_bounded_body as _read_bounded_body
from app.core.observability import failure_cause
from app.main import create_app
from tests.config_support import settings_values

MOCK_DATABASE_PASSWORD = token_urlsafe(32)


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


class _DriverError(Exception):
    def __init__(self, sqlstate: str | None) -> None:
        self.sqlstate = sqlstate


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (OperationalError("SELECT 1", {}, _DriverError("40P01")), "database_deadlock"),
        (OperationalError("SELECT 1", {}, _DriverError("40001")), "database_serialization_failure"),
        (OperationalError("SELECT 1", {}, _DriverError("55P03")), "database_lock_unavailable"),
        (OperationalError("SELECT 1", {}, _DriverError("57014")), "database_statement_timeout"),
        (OperationalError("SELECT 1", {}, _DriverError("08006")), "database_08006"),
        (OperationalError("SELECT 1", {}, _DriverError("bad; code")), "database_operation_failed"),
        (OperationalError("SELECT 1", {}, _DriverError(None)), "database_operation_failed"),
        (SQLAlchemyTimeoutError("checkout timed out"), "database_pool_timeout"),
        (_DriverError("53300"), "database_53300"),
        (HTTPException(409, detail="private detail"), "http_409"),
        (RuntimeError("private detail"), "RuntimeError"),
    ],
)
def test_a_database_failure_logs_its_kind_without_exception_detail(error, reason) -> None:
    # Live seven-pack run: a 503 logged only database_operation_failed, so a lock conflict
    # could not be told from an outage.
    assert failure_cause(error) == reason


def test_non_file_timeout_is_not_mislabeled_as_a_file_transfer_timeout() -> None:
    app = create_app()

    @app.get("/api/test-downstream-timeout")
    def test_downstream_timeout() -> None:
        raise TimeoutError("unrelated downstream timeout")

    response = TestClient(app).get("/api/test-downstream-timeout")

    assert response.status_code == 500
    assert response.json() == {"detail": "Internal server error"}


def test_expired_file_transfer_deadline_uses_file_timeout_response(monkeypatch) -> None:
    import app.request_middleware as request_middleware
    from app.core.middleware.file_transfers import FileTransferPolicy

    monkeypatch.setattr(
        request_middleware,
        "file_transfer_policy",
        lambda path, method: (
            FileTransferPolicy(1024, 0) if path == "/api/test-file-timeout" else None
        ),
    )
    app = create_app()

    @app.get("/api/test-file-timeout")
    async def test_file_timeout() -> None:
        await asyncio.sleep(0.01)
        return {"status": "unreachable"}

    response = TestClient(app).get("/api/test-file-timeout")

    assert response.status_code == 504
    assert response.json()["detail"]["code"] == "file_timeout"


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


def _json_body_of_size(size: int) -> bytes:
    prefix = b'{"padding":"'
    suffix = b'"}'
    return prefix + (b"x" * (size - len(prefix) - len(suffix))) + suffix


@pytest.mark.parametrize(
    "path,method",
    [("/api/sandbox/document", "put"), ("/api/sandbox/imports", "post")],
)
def test_sandbox_document_routes_admit_five_mib_declared_and_actual_bodies_before_auth(
    path: str, method: str
) -> None:
    limit = 5 * 1024 * 1024
    client = TestClient(create_app())

    declared = client.request(
        method,
        path,
        content=b"{}",
        headers={"Content-Length": str(limit), "Content-Type": "application/json"},
    )
    actual = client.request(
        method,
        path,
        content=_json_body_of_size(limit),
        headers={"Content-Length": "1", "Content-Type": "application/json"},
    )

    assert declared.status_code == 401
    assert actual.status_code == 401


@pytest.mark.parametrize(
    "path,method",
    [("/api/sandbox/document", "put"), ("/api/sandbox/imports", "post")],
)
def test_sandbox_document_routes_reject_declared_and_actual_bodies_over_five_mib(
    path: str, method: str
) -> None:
    limit = 5 * 1024 * 1024
    client = TestClient(create_app())

    declared = client.request(
        method,
        path,
        content=b"{}",
        headers={"Content-Length": str(limit + 1), "Content-Type": "application/json"},
    )
    actual = client.request(
        method,
        path,
        content=_json_body_of_size(limit + 1),
        headers={"Content-Length": "1", "Content-Type": "application/json"},
    )

    assert declared.status_code == 413
    assert actual.status_code == 413


def test_ordinary_routes_retain_the_one_mib_request_limit() -> None:
    response = TestClient(create_app()).post(
        "/api/records/query",
        content=_json_body_of_size(1024 * 1024 + 1),
        headers={"Content-Length": "1", "Content-Type": "application/json"},
    )

    assert response.status_code == 413


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


def test_file_content_limit_is_scoped_to_real_uuid_transfer_paths() -> None:
    client = TestClient(create_app())
    body = b"x" * (1024 * 1024 + 1)
    valid = client.put(
        "/api/files/019c0000-0000-7000-8000-000000000001/content",
        content=body,
        headers={"content-type": "application/octet-stream"},
    )
    assert valid.status_code == 401
    forged = client.put("/api/files/not-an-id/content", content=body)
    assert forged.status_code == 413
    ordinary = client.post("/api/records/query", content=body)
    assert ordinary.status_code == 413


def test_file_capacity_is_acquired_before_buffering_and_released_on_denial(monkeypatch) -> None:
    from app.systems.platform.files import providers

    monkeypatch.setattr(providers, "_pool", providers.FileCapacity(1, 4))
    client = TestClient(create_app())
    url = "/api/files/019c0000-0000-7000-8000-000000000001/content"
    with providers.transfer_admission(1):
        busy = client.put(url, content=b"x")
        assert busy.status_code == 503
        assert busy.json()["detail"]["code"] == "files_busy"
        assert busy.headers["Retry-After"] == "1"
        assert client.get("/api/health").status_code == 200
        # Metadata routes reach authentication while the file budget is full.
        assert client.post(url.replace("/content", "/archive")).status_code == 401
    # Each denied upload returns its one-byte reservation, so the next one is admitted.
    assert client.put(url, content=b"x").status_code == 401
    assert client.put(url, content=b"x").status_code == 401
    assert client.put(url, content=b"x").status_code == 401


def test_readiness_returns_generic_status_and_disables_caching(monkeypatch) -> None:
    import app.main as main

    snapshot = {
        "status": "not_ready",
        "components": {
            "database": {"status": "unavailable", "required": True},
            "auth": {"status": "ready", "required": True},
            "storage": {"status": "ready", "required": True},
            "smtp": {"status": "ready", "required": True},
        },
    }
    monkeypatch.setattr(main, "get_readiness_snapshot", lambda: snapshot)
    response = TestClient(create_app()).get("/api/ready")

    assert response.status_code == 503
    assert response.json() == snapshot
    assert response.headers["Cache-Control"] == "no-store"


def test_runtime_engine_uses_bounded_connection_settings(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def create_engine_spy(*args: object, **kwargs: object):
        captured.update(kwargs)
        return Mock(spec=Engine)

    settings = Settings(
        **settings_values(
            database_url=f"postgresql+psycopg://test:{MOCK_DATABASE_PASSWORD}@localhost/test"
        ),
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


def test_health_returns_service_status() -> None:
    response = TestClient(create_app()).get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "openslate-api"}


def test_health_exposes_the_non_secret_instance_handshake(monkeypatch) -> None:
    import app.main as main

    monkeypatch.setattr(main, "instance_identity_for_process", lambda: "a" * 64)

    response = TestClient(create_app()).get("/api/health")

    assert response.status_code == 200
    assert response.headers["X-OpenSlate-Instance"] == "a" * 64


@pytest.mark.parametrize(
    ("environment_name", "invalid_value", "expected_field"),
    [
        ("REQUEST_BODY_MAX_BYTES", "0", "REQUEST_BODY_MAX_BYTES"),
        ("DATABASE_POOL_SIZE", "0", "DATABASE_POOL_SIZE"),
        ("DATABASE_MAX_OVERFLOW", "-1", "DATABASE_MAX_OVERFLOW"),
        ("DATABASE_POOL_TIMEOUT_SECONDS", "0", "DATABASE_POOL_TIMEOUT_SECONDS"),
        ("DATABASE_CONNECT_TIMEOUT_SECONDS", "0", "DATABASE_CONNECT_TIMEOUT_SECONDS"),
        ("DATABASE_STATEMENT_TIMEOUT_MS", "0", "DATABASE_STATEMENT_TIMEOUT_MS"),
        ("READINESS_POOL_TIMEOUT_SECONDS", "0", "READINESS_POOL_TIMEOUT_SECONDS"),
        ("READINESS_CONNECT_TIMEOUT_SECONDS", "0", "READINESS_CONNECT_TIMEOUT_SECONDS"),
        ("READINESS_STATEMENT_TIMEOUT_MS", "0", "READINESS_STATEMENT_TIMEOUT_MS"),
        ("READINESS_CALLER_TIMEOUT_SECONDS", "nan", "READINESS_CALLER_TIMEOUT_SECONDS"),
    ],
)
def test_runtime_limit_environment_values_must_preserve_their_bounds(
    monkeypatch: pytest.MonkeyPatch,
    environment_name: str,
    invalid_value: str,
    expected_field: str,
) -> None:
    monkeypatch.setenv(
        "DATABASE_URL", f"postgresql+psycopg://test:{MOCK_DATABASE_PASSWORD}@localhost/test"
    )
    monkeypatch.setenv(environment_name, invalid_value)

    with pytest.raises(ValidationError) as error:
        Settings.model_validate(dict(os.environ))

    assert expected_field in str(error.value)


def test_a_provider_failure_names_what_failed_without_its_message() -> None:
    # Live seven-pack run: an export failed as exports:ProviderUnavailable and a restore
    # confirmation as 503 with no cause; the provider errors now carry a bounded kind.
    import httpx

    from app.core.integrations.supabase_auth import SupabaseAuthUnavailable, _json_response
    from app.systems.platform.files.providers import ProviderUnavailable
    from app.systems.platform.files.supabase_storage import SupabaseStorage

    with pytest.raises(SupabaseAuthUnavailable) as auth:
        _json_response(httpx.Response(429, text="private detail"))
    assert failure_cause(auth.value) == "SupabaseAuthUnavailable_http_429"
    with pytest.raises(ProviderUnavailable) as storage:
        SupabaseStorage._require_success(503)
    assert failure_cause(storage.value) == "ProviderUnavailable_http_503"
    assert failure_cause(ProviderUnavailable("x", kind="bad kind; drop")) == "ProviderUnavailable"
