from datetime import UTC, datetime, timedelta
from hashlib import sha256
from unittest.mock import Mock
from uuid import UUID

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from starlette.requests import Request
from starlette.responses import Response
from uuid6 import uuid7

from app.common.dependencies.auth import CurrentIdentity, get_current_identity
from app.core.database import get_db
from app.core.security.passwords import PasswordPolicyError, hash_password, verify_password
from app.core.security.tokens import TokenType, create_token, decode_token
from app.main import create_app
from app.systems.access.identity.models import (
    ActionTokenPurpose,
    IdentityActionToken,
    IdentitySession,
)
from app.systems.access.identity.service import (
    InvalidCredentials,
    RefreshReplayDetected,
    _digest,
    _login_fingerprint,
    _rotate_session_tokens,
    authenticate_password,
    cleanup_expired_rate_limit_buckets,
    invalidate_action_tokens,
    refresh_session,
    replace_password,
    revoke_refresh_session,
    validate_access_session,
)
from app.systems.access.users.models import Role, User, UserRole, UserStatus
from tests.auth.local_identity_support import request as _request
from tests.auth.local_identity_support import settings as _settings


def test_identity_service_wildcard_import_keeps_public_operations() -> None:
    namespace: dict[str, object] = {}
    exec("from app.systems.access.identity.service import *", namespace)

    assert callable(namespace["authenticate_password"])
    assert callable(namespace["issue_session"])


def test_local_password_hash_uses_argon2_and_enforces_policy() -> None:
    password = "correct horse battery staple 2026"

    digest = hash_password(password)

    assert digest.startswith("$argon2id$")
    assert verify_password(password, digest)
    with pytest.raises(PasswordPolicyError):
        hash_password("short")
    with pytest.raises(PasswordPolicyError):
        hash_password("passwordpassword")
    with pytest.raises(PasswordPolicyError):
        hash_password("letmeinletmein")


def test_local_access_token_has_identity_and_session_claims(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    subject = UUID("00000000-0000-0000-0000-000000000123")
    session_id = UUID("00000000-0000-0000-0000-000000000456")
    now = datetime.now(UTC)
    monkeypatch.setattr("app.core.security.tokens.get_settings", lambda: _settings())

    token = create_token(subject, session_id, TokenType.ACCESS, now=now)

    claims = decode_token(token, TokenType.ACCESS, now=now + timedelta(minutes=1))
    assert claims is not None
    assert claims["sub"] == str(subject)
    assert claims["sid"] == str(session_id)
    assert claims["type"] == TokenType.ACCESS.value

    setup_token = create_token(subject, session_id, TokenType.ACCESS, now=now, setup_only=True)
    setup_claims = decode_token(setup_token, TokenType.ACCESS, now=now + timedelta(minutes=1))
    assert setup_claims is not None
    assert float(setup_claims["exp"]) - float(setup_claims["iat"]) == 600


def test_login_fingerprint_is_keyed_and_context_separated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.systems.access.identity.service.get_settings", lambda: _settings())

    fingerprint = _login_fingerprint("person@example.com", "127.0.0.1")

    assert fingerprint != sha256(b"person@example.com\x00127.0.0.1").hexdigest()
    assert fingerprint != _login_fingerprint("person@example.com", "127.0.0.2")


def test_unknown_identity_still_performs_one_password_verification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    db.scalar.return_value = None
    verified = Mock(return_value=False)
    monkeypatch.setattr(
        "app.systems.access.identity.service._lock_rate_limit_bucket", lambda *_args: None
    )
    monkeypatch.setattr(
        "app.systems.access.identity.service._record_failed_login", lambda *_args: None
    )
    monkeypatch.setattr(
        "app.systems.access.identity.service.cleanup_expired_rate_limit_buckets",
        lambda *_args, **_kwargs: 0,
    )
    monkeypatch.setattr("app.systems.access.identity.service.verify_password", verified)

    with pytest.raises(InvalidCredentials):
        authenticate_password(db, "unknown@example.test", "wrong password")

    verified.assert_called_once()


def test_rate_limit_cleanup_removes_only_expired_buckets() -> None:
    db = Mock(spec=Session)
    stale = Mock()
    db.scalars.return_value = [stale]

    removed = cleanup_expired_rate_limit_buckets(db, now=datetime.now(UTC))

    assert removed == 1
    db.delete.assert_called_once_with(stale)


def test_identity_security_change_consumes_an_outstanding_recovery_token() -> None:
    now = datetime.now(UTC)
    action = IdentityActionToken(
        user_id=uuid7(),
        purpose=ActionTokenPurpose.RECOVERY,
        token_digest="a" * 64,
        expires_at=now + timedelta(minutes=30),
    )
    db = Mock(spec=Session)
    db.scalars.return_value = [action]

    invalidate_action_tokens(db, action.user_id, now=now)

    assert action.consumed_at == now


def test_pending_setup_session_is_accepted_only_for_a_setup_claim() -> None:
    user_id = uuid7()
    session_id = uuid7()
    now = datetime.now(UTC)
    user = User(
        id=user_id,
        email="pending@example.com",
        username="pending",
        status="pending",
        role_id=uuid7(),
        role=Role(role=UserRole.MEMBER, permissions={}),
    )
    session = IdentitySession(
        id=session_id,
        user_id=user_id,
        refresh_token_digest="setup",
        csrf_token_digest="digest",
        expires_at=now + timedelta(minutes=10),
    )
    db = Mock(spec=Session)
    db.get.return_value = session
    db.scalar.return_value = user
    claims: dict[str, object] = {
        "sub": str(user_id),
        "sid": str(session_id),
        "iat": now.timestamp(),
    }

    assert validate_access_session(db, claims, allow_setup=False, now=now) is None
    assert validate_access_session(db, claims, allow_setup=True, now=now) is user


def test_setup_claim_is_rejected_for_an_active_user_without_setup_access() -> None:
    user_id = uuid7()
    session_id = uuid7()
    now = datetime.now(UTC)
    user = User(
        id=user_id,
        email="active@example.com",
        username="active",
        status=UserStatus.ACTIVE.value,
        role_id=uuid7(),
        role=Role(role=UserRole.MEMBER, permissions={}),
    )
    session = IdentitySession(
        id=session_id,
        user_id=user_id,
        refresh_token_digest="refresh-digest",
        csrf_token_digest="csrf-digest",
        expires_at=now + timedelta(days=1),
    )
    db = Mock(spec=Session)
    db.get.return_value = session
    db.scalar.return_value = user
    claims: dict[str, object] = {
        "sub": str(user_id),
        "sid": str(session_id),
        "iat": now.timestamp(),
        "setup": True,
    }

    assert validate_access_session(db, claims, allow_setup=False, now=now) is None


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


def test_valid_refresh_can_revoke_an_expired_access_session_and_clear_cookies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.systems.access.auth.router import _clear_browser_session

    user_id = uuid7()
    session_id = uuid7()
    refresh_id = "refresh-identifier"
    now = datetime.now(UTC)
    session = IdentitySession(
        id=session_id,
        user_id=user_id,
        refresh_token_digest=_digest(refresh_id),
        csrf_token_digest="digest",
        expires_at=now + timedelta(days=1),
    )
    db = Mock(spec=Session)
    db.get.return_value = session
    monkeypatch.setattr(
        "app.systems.access.identity.service.decode_token",
        lambda *_args, **_kwargs: {"sub": str(user_id), "sid": str(session_id), "jti": refresh_id},
    )

    assert revoke_refresh_session(db, "refresh", now=now)
    assert session.revoked_at == now
    response = Response()
    _clear_browser_session(response)
    cookie_headers = response.headers.getlist("set-cookie")
    assert any('openslate_access=""' in header and "Path=/" in header for header in cookie_headers)
    assert any('openslate_refresh=""' in header for header in cookie_headers)


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
        role_id=uuid7(),
        role=Role(role=UserRole.MEMBER, permissions={}),
    )
    db = Mock(spec=Session)
    db.get.return_value = session
    monkeypatch.setattr("app.systems.access.auth.router.get_settings", lambda: _settings())
    monkeypatch.setattr(
        "app.systems.access.auth.router.get_current_identity",
        lambda *_args: CurrentIdentity(user, session.id, True, False),
    )
    application = create_app()
    application.dependency_overrides[get_db] = lambda: db

    with TestClient(application, raise_server_exceptions=False) as client:
        response = client.post(
            "/api/auth/logout",
            headers={
                "Origin": "http://frontend.test",
                "Cookie": "openslate_access=access; openslate_refresh=refresh; openslate_csrf=csrf",
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


def test_refresh_only_logout_requires_the_session_bound_csrf_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id = uuid7()
    session_id = uuid7()
    now = datetime.now(UTC)
    session = IdentitySession(
        id=session_id,
        user_id=user_id,
        refresh_token_digest=_digest("refresh-id"),
        csrf_token_digest=_digest("expected-csrf"),
        expires_at=now + timedelta(days=1),
    )
    db = Mock(spec=Session)
    db.get.return_value = session
    monkeypatch.setattr(
        "app.systems.access.identity.service.decode_token",
        lambda *_args, **_kwargs: {
            "sub": str(user_id),
            "sid": str(session_id),
            "jti": "refresh-id",
        },
    )

    assert not revoke_refresh_session(db, "refresh", csrf_token="wrong-csrf", now=now)
    assert session.revoked_at is None


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


def test_refresh_replay_revokes_the_session_and_raises_a_distinct_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id = uuid7()
    session_id = uuid7()
    now = datetime.now(UTC)
    session = IdentitySession(
        id=session_id,
        user_id=user_id,
        refresh_token_digest="different-refresh",
        csrf_token_digest="csrf",
        expires_at=now + timedelta(days=1),
    )
    db = Mock(spec=Session)
    db.get.return_value = session
    monkeypatch.setattr(
        "app.systems.access.identity.service.decode_token",
        lambda *_args, **_kwargs: {"sub": str(user_id), "sid": str(session_id), "jti": "replayed"},
    )

    with pytest.raises(RefreshReplayDetected):
        refresh_session(db, "replayed", now=now)

    assert session.revoked_at == now


def test_setup_sessions_have_a_unique_non_refreshable_digest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.core.security.tokens.get_settings", lambda: _settings())
    now = datetime.now(UTC)
    first = IdentitySession(
        id=uuid7(),
        user_id=uuid7(),
        refresh_token_digest="pending",
        csrf_token_digest="pending",
        expires_at=now,
    )
    second = IdentitySession(
        id=uuid7(),
        user_id=first.user_id,
        refresh_token_digest="pending",
        csrf_token_digest="pending",
        expires_at=now,
    )

    first_issued = _rotate_session_tokens(first, first.user_id, setup_only=True, now=now)
    second_issued = _rotate_session_tokens(second, second.user_id, setup_only=True, now=now)

    assert first_issued.refresh_token is None
    assert second_issued.refresh_token is None
    assert first.refresh_token_digest != second.refresh_token_digest


def test_temporary_password_change_activates_user_and_uses_second_precision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = User(
        id=uuid7(),
        email="setup@example.com",
        username="setup",
        status=UserStatus.PENDING.value,
        role_id=uuid7(),
        role=Role(role=UserRole.MEMBER, permissions={}),
    )
    credential = Mock(must_change_password=True, temporary_password_expires_at=datetime.now(UTC))
    db = Mock(spec=Session)
    db.get.return_value = credential
    db.scalars.return_value = []
    monkeypatch.setattr(
        "app.systems.access.identity.service.hash_password", lambda _value: "argon2"
    )
    now = datetime(2026, 9, 19, 9, 0, 0, 999999, tzinfo=UTC)

    replace_password(db, user, "correct horse battery staple", now=now)

    assert user.status == UserStatus.ACTIVE.value
    assert user.invitation_accepted_at == now.replace(microsecond=0)
    assert user.tokens_valid_after == now.replace(microsecond=0)
    assert credential.must_change_password is False
