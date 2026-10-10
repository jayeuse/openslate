from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response
from pydantic import ValidationError
from starlette.requests import Request

import app.systems.access.auth.router as auth_router
from app.core.config import Settings
from app.systems.access.auth import cookies, request_security
from tests.config_support import settings_values


def _request(origin: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/auth/login",
            "headers": [(b"origin", origin.encode())],
        }
    )


def test_public_origin_is_normalized_and_browser_requests_require_its_exact_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings(
        **settings_values(public_origin="https://APP.EXAMPLE.TEST:443/"), _env_file=None
    )
    monkeypatch.setattr(
        request_security,
        "get_settings",
        lambda: SimpleNamespace(public_origin=settings.public_origin),
    )

    assert settings.public_origin == "https://app.example.test"
    auth_router._require_browser_origin(_request("https://app.example.test"))
    with pytest.raises(HTTPException, match="Invalid request origin"):
        auth_router._require_browser_origin(_request("https://app.example.test:443"))


@pytest.mark.parametrize(
    "origin",
    ["http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000"],
)
def test_development_allows_loopback_http_public_origins(origin: str) -> None:
    settings = Settings(
        **settings_values(
            environment="development", public_origin=origin, auth_jwt_issuer=origin
        ),
        _env_file=None,
    )

    assert settings.public_origin == origin


@pytest.mark.parametrize(
    "environment, origin",
    [
        ("development", "http://app.example.test"),
        ("production", "http://127.0.0.1:3000"),
    ],
)
def test_non_loopback_development_and_production_reject_http_public_origins(
    environment: str, origin: str
) -> None:
    with pytest.raises(ValidationError, match="PUBLIC_ORIGIN"):
        Settings(
            **settings_values(
                environment=environment,
                public_origin=origin,
                web_assets_root="/tmp/openslate-test-web",
            ),
            _env_file=None,
        )


def test_browser_session_cookies_are_non_secure_only_for_development_loopback_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def cookie_headers(*, environment: str, public_origin: str) -> list[str]:
        monkeypatch.setattr(
            cookies,
            "get_settings",
            lambda: SimpleNamespace(
                environment=environment,
                public_origin=public_origin,
                backend_bind_host="127.0.0.1",
            ),
        )
        response = Response()
        cookies.set_browser_session(response, "access", "refresh", "csrf")
        cookies.clear_browser_session(response)
        return response.headers.getlist("set-cookie")

    development_headers = cookie_headers(
        environment="development", public_origin="http://127.0.0.1:3000"
    )
    test_headers = cookie_headers(environment="test", public_origin="http://frontend.test")
    production_headers = cookie_headers(
        environment="production", public_origin="https://app.example.test"
    )

    assert development_headers and all("Secure" not in header for header in development_headers)
    assert test_headers and all("Secure" in header for header in test_headers)
    assert production_headers and all("Secure" in header for header in production_headers)
