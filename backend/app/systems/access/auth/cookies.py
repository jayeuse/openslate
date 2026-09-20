"""Browser cookie helpers for the local identity routes."""

from fastapi import Response
from fastapi.responses import JSONResponse


def set_browser_session(response: Response, access: str, refresh: str | None, csrf: str) -> None:
    response.set_cookie(
        "openslate_access", access, httponly=True, secure=True, samesite="lax", path="/"
    )
    if refresh is None:
        response.delete_cookie("openslate_refresh", path="/api/auth")
    else:
        response.set_cookie(
            "openslate_refresh",
            refresh,
            httponly=True,
            secure=True,
            samesite="strict",
            path="/api/auth",
        )
    response.set_cookie(
        "openslate_csrf", csrf, httponly=False, secure=True, samesite="lax", path="/"
    )


def clear_browser_session(response: Response) -> None:
    response.delete_cookie("openslate_access", path="/")
    response.delete_cookie("openslate_refresh", path="/api/auth")
    response.delete_cookie("openslate_csrf", path="/")


def cleared_auth_error() -> JSONResponse:
    response = JSONResponse(
        status_code=401, content={"detail": "Invalid authentication credentials"}
    )
    clear_browser_session(response)
    return response
