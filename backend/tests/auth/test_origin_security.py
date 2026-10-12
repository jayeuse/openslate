from http.cookies import Morsel, SimpleCookie
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
    with pytest.raises(HTTPException, match="Invalid request origin") as refused:
        auth_router._require_browser_origin(_request("https://app.example.test:443"))
    assert refused.value.status_code == 403


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


def _cookies(response: Response) -> dict[str, Morsel[str]]:
    morsels: dict[str, Morsel[str]] = {}
    for header in response.headers.getlist("set-cookie"):
        jar: SimpleCookie = SimpleCookie()
        jar.load(header)
        morsels.update(jar)
    return morsels


def _live(morsel: Morsel[str]) -> tuple[str, str, bool, bool, str]:
    # Browsers match the SameSite value case-insensitively (RFC 6265bis 5.4.7).
    samesite = morsel["samesite"].lower()
    return morsel.value, morsel["path"], bool(morsel["httponly"]), bool(morsel["secure"]), samesite


def _deleted(morsel: Morsel[str]) -> tuple[str, str, bool, str]:
    return morsel.value, morsel["path"], bool(morsel["secure"]), str(morsel["max-age"])


@pytest.fixture
def production_cookies(monkeypatch: pytest.MonkeyPatch) -> None:
    production = SimpleNamespace(
        environment="production",
        public_origin="https://app.example.test",
        backend_bind_host="127.0.0.1",
    )
    monkeypatch.setattr(cookies, "get_settings", lambda: production)


@pytest.mark.usefixtures("production_cookies")
def test_browser_session_cookies_carry_the_documented_scope_and_flags() -> None:
    # Access and refresh are HttpOnly (Lax and Strict); the web client reads the CSRF cookie,
    # so it is not HttpOnly; the refresh handle is sent only to /api/auth.
    response = Response()
    cookies.set_browser_session(response, "access", "refresh", "csrf")
    issued = _cookies(response)
    assert sorted(issued) == ["openslate_access", "openslate_csrf", "openslate_refresh"]
    assert _live(issued["openslate_access"]) == ("access", "/", True, True, "lax")
    assert _live(issued["openslate_refresh"]) == ("refresh", "/api/auth", True, True, "strict")
    assert _live(issued["openslate_csrf"]) == ("csrf", "/", False, True, "lax")

    access_only = Response()
    cookies.set_browser_access(access_only, "renewed")
    assert _live(_cookies(access_only)["openslate_access"]) == ("renewed", "/", True, True, "lax")


@pytest.mark.usefixtures("production_cookies")
def test_a_session_without_refresh_handle_deletes_the_stale_refresh_cookie() -> None:
    response = Response()
    cookies.set_browser_session(response, "access", None, "csrf")
    issued = _cookies(response)
    assert sorted(issued) == ["openslate_access", "openslate_csrf", "openslate_refresh"]
    assert _deleted(issued["openslate_refresh"]) == ("", "/api/auth", True, "0")
    assert _live(issued["openslate_access"]) == ("access", "/", True, True, "lax")


@pytest.mark.usefixtures("production_cookies")
def test_a_refused_refresh_returns_the_uniform_401_and_deletes_every_session_cookie() -> None:
    response = cookies.cleared_auth_error()
    assert response.status_code == 401
    assert response.body == b'{"detail":"Invalid authentication credentials"}'
    cleared = _cookies(response)
    assert sorted(cleared) == ["openslate_access", "openslate_csrf", "openslate_refresh"]
    assert _deleted(cleared["openslate_access"]) == ("", "/", True, "0")
    assert _deleted(cleared["openslate_refresh"]) == ("", "/api/auth", True, "0")
    assert _deleted(cleared["openslate_csrf"]) == ("", "/", True, "0")
