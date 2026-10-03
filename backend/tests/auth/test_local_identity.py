"""Retained backend cookie, revocation and rate-budget contracts after Auth cutover."""

from datetime import UTC, datetime, timedelta
from hashlib import sha256
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy.orm import Session
from starlette.requests import Request
from starlette.responses import Response
from uuid6 import uuid7

from app.common.dependencies.auth import CurrentIdentity, get_current_identity
from app.core.database import get_db
from app.systems.access.auth.router import auth_router
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.provider_sessions import revoke_provider_refresh_session
from app.systems.access.identity.rate_limits import cleanup_expired_buckets, login_fingerprint
from app.systems.access.users.models import User, UserRole, UserStatus
from tests.auth.local_identity_support import request as _request


def _settings():
    return SimpleNamespace(
        public_origin="http://frontend.test",
        security_event_server_key=SecretStr("a" * 64),
    )


def test_login_fingerprint_is_keyed_and_context_separated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.systems.access.identity.rate_limits.get_settings", lambda: _settings())

    fingerprint = login_fingerprint("person@example.com", "127.0.0.1")

    assert fingerprint != sha256(b"person@example.com\x00127.0.0.1").hexdigest()
    assert fingerprint != login_fingerprint("person@example.com", "127.0.0.2")


def test_rate_limit_cleanup_removes_only_expired_buckets() -> None:
    db = Mock(spec=Session)
    stale = Mock()
    db.scalars.return_value = [stale]

    removed = cleanup_expired_buckets(db, now_value=datetime.now(UTC))

    assert removed == 1
    db.delete.assert_called_once_with(stale)


def test_browser_session_cookies_reach_all_api_routes_and_origin_is_exact(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.systems.access.auth.router import _require_browser_origin, _set_browser_session

    monkeypatch.setattr("app.systems.access.auth.router.get_settings", lambda: _settings())
    response = Response()
    _set_browser_session(response, "access", "refresh", "csrf")
    cookie_headers = response.headers.getlist("set-cookie")

    assert any(
        "openslate_access=access" in header and "Path=/" in header for header in cookie_headers
    )
    assert any("openslate_csrf=csrf" in header and "Path=/" in header for header in cookie_headers)
    _require_browser_origin(_request("http://frontend.test"))
    with pytest.raises(HTTPException):
        _require_browser_origin(_request("http://untrusted.test"))


def test_registered_logout_returns_204_clears_cookies_and_revokes_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id = uuid7()
    session = IdentitySession(
        id=uuid7(),
        user_id=user_id,
        refresh_token_digest="refresh-digest",
        csrf_token_digest="csrf-digest",
        expires_at=datetime.now(UTC) + timedelta(days=1),
    )
    user = User(
        id=user_id,
        email="logout@example.com",
        username="logout",
        status=UserStatus.ACTIVE.value,
        role=UserRole.MEMBER,
    )
    db = Mock(spec=Session)
    db.get.return_value = session
    monkeypatch.setattr("app.systems.access.auth.router.get_settings", lambda: _settings())
    monkeypatch.setattr(
        "app.systems.access.auth.router.get_mfa_identity",
        lambda *_args: CurrentIdentity(user, session.id, True, False),
    )
    application = FastAPI()
    application.include_router(auth_router, prefix="/api")
    monkeypatch.setattr("app.systems.access.auth.router.attempt_provider_signout", Mock())
    application.dependency_overrides[get_db] = lambda: db

    with TestClient(application, raise_server_exceptions=False) as client:
        response = client.post(
            "/api/auth/logout",
            headers={
                "Origin": "http://frontend.test",
                "Cookie": "openslate_access=access; openslate_csrf=csrf",
                "X-CSRF-Token": "csrf",
            },
        )

    assert response.status_code == 204
    cookie_headers = response.headers.get_list("set-cookie")
    assert any('openslate_access=""' in header and "Path=/" in header for header in cookie_headers)
    assert any(
        'openslate_refresh=""' in header and "Path=/api/auth" in header for header in cookie_headers
    )
    assert any('openslate_csrf=""' in header and "Path=/" in header for header in cookie_headers)
    assert session.revoked_at is not None
    db.commit.assert_called_once()
    application.dependency_overrides.clear()


@pytest.mark.parametrize("authorization", ["Bearer token", "Basic credentials", "not-a-bearer"])
def test_any_authorization_header_with_refresh_cookie_is_rejected(authorization: str) -> None:
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/auth/session",
            "headers": [
                (b"authorization", authorization.encode()),
                (b"cookie", b"openslate_refresh=refresh-token"),
            ],
            "client": ("127.0.0.1", 50000),
            "scheme": "https",
            "server": ("localhost", 443),
        }
    )

    with pytest.raises(HTTPException) as error:
        get_current_identity(request, None, Mock(spec=Session))

    assert error.value.status_code == 401


@pytest.mark.parametrize("csrf", ["expected-csrf", "wrong-csrf"])
def test_refresh_handle_can_revoke_without_access_jwt_only_with_bound_csrf(csrf):
    timestamp = datetime.now(UTC)
    refresh_handle = "r" * 48
    session = IdentitySession(
        id=uuid7(),
        user_id=uuid7(),
        provider_session_id=uuid7(),
        refresh_token_digest=sha256(refresh_handle.encode()).hexdigest(),
        csrf_token_digest=sha256(b"expected-csrf").hexdigest(),
        expires_at=timestamp + timedelta(days=1),
    )
    db = Mock(spec=Session)
    db.scalar.return_value = db.get.return_value = session
    result = revoke_provider_refresh_session(db, refresh_handle, csrf_token=csrf)
    if csrf == "expected-csrf":
        assert result == session.id
        assert session.revoked_at is not None and session.revoked_at >= timestamp
    else:
        assert result is None
        assert session.revoked_at is None
