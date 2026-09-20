"""Browser cookie helpers for the local identity routes."""

from urllib.parse import urlsplit

from fastapi import Response
from fastapi.responses import JSONResponse

from app.core.config import get_settings
from app.core.config.development import is_relaxed_development


def _browser_cookie_secure() -> bool:
    settings = get_settings()
    return not (
        is_relaxed_development(settings) and urlsplit(settings.public_origin).scheme == "http"
    )


def set_browser_session(response: Response, access: str, refresh: str | None, csrf: str) -> None:
    secure = _browser_cookie_secure()
    response.set_cookie(
        "openslate_access", access, httponly=True, secure=secure, samesite="lax", path="/"
    )
    if refresh is None:
        response.delete_cookie("openslate_refresh", path="/api/auth", secure=secure)
    else:
        response.set_cookie(
            "openslate_refresh",
            refresh,
            httponly=True,
            secure=secure,
            samesite="strict",
            path="/api/auth",
        )
    response.set_cookie(
        "openslate_csrf", csrf, httponly=False, secure=secure, samesite="lax", path="/"
    )


def clear_browser_session(response: Response) -> None:
    secure = _browser_cookie_secure()
    response.delete_cookie("openslate_access", path="/", secure=secure)
    response.delete_cookie("openslate_refresh", path="/api/auth", secure=secure)
    response.delete_cookie("openslate_csrf", path="/", secure=secure)


def cleared_auth_error() -> JSONResponse:
    response = JSONResponse(
        status_code=401, content={"detail": "Invalid authentication credentials"}
    )
    clear_browser_session(response)
    return response
