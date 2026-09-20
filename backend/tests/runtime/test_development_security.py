from unittest.mock import Mock
from uuid import uuid4

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

import app.common.dependencies.auth as auth_dependencies
import app.main as main
from app import __main__ as entrypoint
from app.core.config import Settings
from app.core.config.development import browser_origin_is_permitted, is_relaxed_development
from app.systems.access.identity.rate_limits import invitation_completion_permitted
from app.systems.access.identity.service import InvalidCredentials, authenticate_password
from tests.config_support import settings_values


def _development_settings(**overrides: object) -> Settings:
    public_origin = str(overrides.get("public_origin", "http://127.0.0.1:3000"))
    values = settings_values(
        environment="development",
        public_origin=public_origin,
        auth_jwt_issuer=public_origin,
        backend_bind_host="127.0.0.1",
    )
    values.update(overrides)
    return Settings(**values, _env_file=None)


@pytest.mark.parametrize(
    "origin",
    [
        None,
        "http://localhost:3000",
        "https://127.0.0.1:4443",
        "http://192.168.1.20:3000",
        "http://169.254.10.20:3000",
        "http://[fe80::1]:3000",
    ],
)
def test_loopback_development_accepts_missing_and_local_browser_origins(origin: str | None) -> None:
    assert browser_origin_is_permitted(_development_settings(), origin)


@pytest.mark.parametrize(
    "origin",
    [
        "https://example.test",
        "http://8.8.8.8:3000",
        "http://0.0.0.0:3000",
        "http://192.0.2.1:3000",
        "http://224.0.0.1:3000",
        "http://[::]:3000",
        "ftp://localhost:3000",
        "null",
    ],
)
def test_loopback_development_rejects_non_local_or_malformed_browser_origins(origin: str) -> None:
    assert not browser_origin_is_permitted(_development_settings(), origin)


def test_test_and_non_loopback_development_retain_exact_browser_origin_requirement() -> None:
    test_settings = Settings(**settings_values(), _env_file=None)
    non_loopback_development = _development_settings(
        backend_bind_host="0.0.0.0", public_origin="https://app.example.test"
    )

    assert not is_relaxed_development(test_settings)
    assert not is_relaxed_development(non_loopback_development)
    assert browser_origin_is_permitted(test_settings, test_settings.public_origin)
    assert not browser_origin_is_permitted(test_settings, None)
    assert not browser_origin_is_permitted(test_settings, "http://localhost:3000")
    assert browser_origin_is_permitted(
        non_loopback_development, non_loopback_development.public_origin
    )
    assert not browser_origin_is_permitted(non_loopback_development, None)


@pytest.mark.parametrize("public_origin", ["http://192.168.1.20:3000", "http://169.254.10.20"])
def test_loopback_development_allows_private_and_link_local_http_public_origins(
    public_origin: str,
) -> None:
    assert _development_settings(public_origin=public_origin).public_origin == public_origin


def test_loopback_development_requires_canonical_issuer_origin_equality() -> None:
    with pytest.raises(ValueError, match="AUTH_JWT_ISSUER"):
        _development_settings(
            public_origin="http://localhost:3000/",
            auth_jwt_issuer="http://localhost:3000/",
        )


def test_loopback_development_omits_generic_security_headers_and_trusted_host_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(main, "get_settings", _development_settings)

    response = TestClient(main.create_app()).get(
        "/api/health", headers={"Host": "untrusted.example.test"}
    )

    assert response.status_code == 200
    assert "X-Content-Type-Options" not in response.headers
    assert "X-Frame-Options" not in response.headers


def test_loopback_development_allows_generic_request_bodies_over_the_configured_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(main, "get_settings", _development_settings)
    app = main.create_app()

    @app.post("/api/test-development-body")
    async def test_development_body(request: Request) -> dict[str, int]:
        return {"size": len(await request.body())}

    payload = b"x" * (_development_settings().request_body_max_bytes + 1)
    response = TestClient(app).post("/api/test-development-body", content=payload)

    assert response.status_code == 200
    assert response.json() == {"size": len(payload)}


def test_loopback_development_skips_anonymous_identity_rate_limit_storage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    cleanup = Mock()
    lock = Mock()
    record = Mock()
    monkeypatch.setattr(
        "app.systems.access.identity.service._cleanup_expired_rate_limit_buckets", cleanup
    )
    monkeypatch.setattr("app.systems.access.identity.service._lock_rate_limit_bucket", lock)
    monkeypatch.setattr("app.systems.access.identity.service._record_failed_login", record)
    monkeypatch.setattr("app.systems.access.identity.service.verify_password", lambda *_args: False)

    with pytest.raises(InvalidCredentials):
        authenticate_password(
            db, "unknown@example.test", "wrong password", enforce_rate_limit=False
        )

    assert invitation_completion_permitted(
        db, source="127.0.0.1", enforce_rate_limit=False
    )
    cleanup.assert_not_called()
    lock.assert_not_called()
    record.assert_not_called()
    db.add.assert_not_called()
    db.execute.assert_not_called()


def test_loopback_development_cookie_mutations_still_require_csrf(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    db.get.return_value = object()
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/test-cookie-mutation",
            "headers": [],
        }
    )
    monkeypatch.setattr(auth_dependencies, "get_settings", _development_settings)
    monkeypatch.setattr(auth_dependencies, "validate_csrf", lambda *_args: False)

    with pytest.raises(HTTPException) as denied:
        auth_dependencies._validate_cookie_mutation(request, db, uuid4())

    assert denied.value.status_code == 401


def test_loopback_development_omits_uvicorn_concurrency_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = Mock()
    monkeypatch.setattr(entrypoint, "get_settings", _development_settings)
    monkeypatch.setattr(entrypoint.uvicorn, "run", run)

    entrypoint.main([])

    assert run.call_args.kwargs["limit_concurrency"] is None
