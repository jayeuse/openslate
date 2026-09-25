"""HTTP-handler contracts for the local Identity boundary.

These tests keep authentication decisions at the router and dependency boundary:
they prove public response behavior, cookie clearing, CSRF transport, and safe
error mapping without recreating the identity service's unit tests.
"""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, Request, Response
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.auth.router as auth_router
import app.systems.access.users.sessions_router as sessions_router
from app.common.dependencies.auth import CurrentIdentity
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.schemas import (
    LoginRequest,
    PasswordChangeRequest,
    RefreshTokenRequest,
)
from app.systems.access.identity.service import (
    IdentityRateLimited,
    InvalidCredentials,
    IssuedSession,
    RefreshReplayDetected,
)
from app.systems.access.users.models import IdentityKind, Role, User, UserRole, UserStatus


def _request(
    *,
    method: str = "POST",
    origin: str | None = "https://app.example.test",
    cookies: str | None = None,
    authorization: str | None = None,
) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if origin is not None:
        headers.append((b"origin", origin.encode()))
    if cookies is not None:
        headers.append((b"cookie", cookies.encode()))
    if authorization is not None:
        headers.append((b"authorization", authorization.encode()))
    return Request(
        {
            "type": "http",
            "method": method,
            "path": "/api/auth/test",
            "headers": headers,
            "client": ("127.0.0.1", 50000),
            "scheme": "https",
            "server": ("app.example.test", 443),
        }
    )


def _role(kind: UserRole = UserRole.MEMBER) -> Role:
    return Role(id=uuid7(), role=kind, permissions={}, is_deleted=False)


def _user(*, status: UserStatus = UserStatus.ACTIVE, role: Role | None = None) -> User:
    selected_role = role or _role()
    now = datetime.now(UTC)
    return User(
        id=uuid7(),
        email="person@example.test",
        username="person",
        status=status.value,
        role_id=selected_role.id,
        role=selected_role,
        identity_kind=IdentityKind.INTERNAL.value,
        created_at=now,
        updated_at=now,
        is_deleted=False,
    )


def _issued(*, setup_only: bool = False) -> IssuedSession:
    return IssuedSession(
        access_token="access-token",
        refresh_token=None if setup_only else "refresh-token",
        csrf_token="csrf-token",
        session_id=uuid7(),
        setup_only=setup_only,
    )


def _cookie_contains(response: Response, value: str) -> bool:
    return any(value in item for item in response.headers.getlist("set-cookie"))


pytestmark = pytest.mark.usefixtures("local_auth_router_settings")


def test_login_sets_browser_cookies_and_maps_rate_and_credential_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    db.info = {}
    user = _user()
    monkeypatch.setattr(auth_router, "authenticate_password", Mock(return_value=user))
    monkeypatch.setattr(auth_router, "issue_session", Mock(return_value=_issued()))
    payload = LoginRequest(identifier="person@example.test", password="correct password")

    response = Response()
    result = auth_router.login(payload, _request(), response, db)

    assert result == {"authenticated": True, "setup_required": False}
    assert db.commit.call_count == 1
    assert _cookie_contains(response, "openslate_access=access-token")
    assert _cookie_contains(response, "openslate_refresh=refresh-token")

    monkeypatch.setattr(
        auth_router, "authenticate_password", Mock(side_effect=InvalidCredentials("bad"))
    )
    with pytest.raises(HTTPException) as invalid:
        auth_router.login(payload, _request(), Response(), db)
    assert invalid.value.status_code == 401
    assert db.commit.call_count == 2

    monkeypatch.setattr(
        auth_router, "authenticate_password", Mock(side_effect=IdentityRateLimited("blocked"))
    )
    with pytest.raises(HTTPException) as rate_limited:
        auth_router.login(payload, _request(), Response(), db)
    assert rate_limited.value.status_code == 429
    assert rate_limited.value.headers == {"Retry-After": "900"}
    db.rollback.assert_called_once()


def test_refresh_browser_session_enforces_cookie_csrf_and_clears_invalid_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    no_cookie = _request()
    with pytest.raises(HTTPException) as missing:
        auth_router.refresh(no_cookie, Response(), db)
    assert missing.value.status_code == 401

    request = _request(cookies="openslate_refresh=old-refresh")
    request.scope["headers"].append((b"x-csrf-token", b"csrf-token"))
    monkeypatch.setattr(auth_router, "refresh_session", Mock(return_value=_issued()))
    response = Response()
    assert auth_router.refresh(request, response, db) == {
        "authenticated": True,
        "setup_required": False,
    }
    assert db.commit.call_count == 1
    assert _cookie_contains(response, "openslate_access=access-token")

    monkeypatch.setattr(
        auth_router, "refresh_session", Mock(side_effect=RefreshReplayDetected("replay"))
    )
    replay = auth_router.refresh(request, Response(), db)
    assert replay.status_code == 401
    assert any('openslate_refresh=""' in item for item in replay.headers.getlist("set-cookie"))

    revoked_session = Mock(revoked_at=None)

    def revoke_then_reject(*_args: object, **_kwargs: object) -> None:
        revoked_session.revoked_at = datetime.now(UTC)
        raise InvalidCredentials("bad")

    monkeypatch.setattr(auth_router, "refresh_session", revoke_then_reject)
    invalid = auth_router.refresh(request, Response(), db)
    assert invalid.status_code == 401
    assert revoked_session.revoked_at is not None
    assert db.commit.call_count == 3
    db.rollback.assert_not_called()


def test_bearer_token_routes_reject_mixed_setup_replay_and_invalid_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    payload = LoginRequest(identifier="person@example.test", password="correct password")
    monkeypatch.setattr(auth_router, "authenticate_password", Mock(return_value=_user()))
    monkeypatch.setattr(auth_router, "issue_session", Mock(return_value=_issued()))

    issued = auth_router.issue_bearer_token(payload, _request(origin=None), db)
    assert issued.access_token == "access-token" and issued.refresh_token == "refresh-token"
    db.commit.assert_called_once()

    monkeypatch.setattr(auth_router, "issue_session", Mock(return_value=_issued(setup_only=True)))
    with pytest.raises(HTTPException) as setup:
        auth_router.issue_bearer_token(payload, _request(origin=None), db)
    assert setup.value.status_code == 403
    assert db.rollback.call_count == 1

    monkeypatch.setattr(
        auth_router, "authenticate_password", Mock(side_effect=IdentityRateLimited("blocked"))
    )
    with pytest.raises(HTTPException) as throttled:
        auth_router.issue_bearer_token(payload, _request(origin=None), db)
    assert throttled.value.status_code == 401

    monkeypatch.setattr(
        auth_router, "authenticate_password", Mock(side_effect=InvalidCredentials("bad"))
    )
    with pytest.raises(HTTPException) as invalid_login:
        auth_router.issue_bearer_token(payload, _request(origin=None), db)
    assert invalid_login.value.status_code == 401

    refresh = RefreshTokenRequest(refresh_token="x" * 32)
    monkeypatch.setattr(auth_router, "refresh_session", Mock(return_value=_issued()))
    refreshed = auth_router.refresh_bearer_token(refresh, _request(origin=None), db)
    assert refreshed.token_type == "bearer"
    monkeypatch.setattr(
        auth_router, "refresh_session", Mock(side_effect=RefreshReplayDetected("replay"))
    )
    with pytest.raises(HTTPException) as replay:
        auth_router.refresh_bearer_token(refresh, _request(origin=None), db)
    assert replay.value.status_code == 401
    monkeypatch.setattr(auth_router, "refresh_session", Mock(side_effect=InvalidCredentials("bad")))
    with pytest.raises(HTTPException) as invalid_refresh:
        auth_router.refresh_bearer_token(refresh, _request(origin=None), db)
    assert invalid_refresh.value.status_code == 401


def test_rejected_password_change_uses_one_timestamp_and_does_not_mutate_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user = _user()
    identity = CurrentIdentity(user, uuid7(), True, False)
    timestamp = datetime.now(UTC)
    authenticate = Mock(return_value=user)
    replace = Mock()
    issue = Mock(return_value=_issued())
    monkeypatch.setattr(auth_router, "utc_now", lambda: timestamp)
    monkeypatch.setattr(auth_router, "authenticate_password", authenticate)
    monkeypatch.setattr(auth_router, "replace_password", replace)
    monkeypatch.setattr(auth_router, "issue_session", issue)
    payload = PasswordChangeRequest(
        current_password="current password", password="new sufficiently long password"
    )

    result = auth_router.change_password(payload, identity, _request(), Response(), db)

    assert result == {"authenticated": True, "setup_required": False}
    assert authenticate.call_args.kwargs["now"] == timestamp
    assert replace.call_args.kwargs["now"] == timestamp
    assert issue.call_args.kwargs["now"] == timestamp

    rejected = Mock(side_effect=InvalidCredentials("invalid"))
    monkeypatch.setattr(auth_router, "authenticate_password", rejected)
    with pytest.raises(HTTPException) as error:
        auth_router.change_password(payload, identity, _request(), Response(), db)
    assert error.value.status_code == 403
    assert replace.call_count == 1
    assert issue.call_count == 1


def test_invalid_bearer_refresh_commits_a_revoked_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    session = Mock(revoked_at=None)
    timestamp = datetime.now(UTC)

    def revoke_then_reject(*_args: object, **_kwargs: object) -> None:
        session.revoked_at = timestamp
        raise InvalidCredentials("invalid")

    monkeypatch.setattr(auth_router, "refresh_session", revoke_then_reject)

    with pytest.raises(HTTPException) as error:
        auth_router.refresh_bearer_token(
            RefreshTokenRequest(refresh_token="x" * 32), _request(origin=None), db
        )

    assert error.value.status_code == 401
    assert session.revoked_at == timestamp
    db.commit.assert_called_once()
    db.rollback.assert_not_called()


def test_logout_rejects_bad_refresh_but_clears_a_valid_browser_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user = _user()
    identity = CurrentIdentity(user, uuid7(), True, False)
    request = _request(cookies="openslate_access=access; openslate_refresh=refresh")
    monkeypatch.setattr(auth_router, "get_current_identity", Mock(return_value=identity))
    revoke = Mock(return_value=True)
    monkeypatch.setattr(auth_router, "revoke_session", revoke)

    response = auth_router.logout(request, db)

    assert response.status_code == 204
    revoke.assert_called_once_with(db, identity.session_id, identity.user.id)
    assert any('openslate_access=""' in item for item in response.headers.getlist("set-cookie"))
    db.commit.assert_called_once()

    monkeypatch.setattr(auth_router, "get_current_identity", Mock(side_effect=HTTPException(401)))
    monkeypatch.setattr(auth_router, "revoke_refresh_session", Mock(return_value=False))
    refresh_only = _request(cookies="openslate_refresh=refresh")
    refresh_only.scope["headers"].append((b"x-csrf-token", b"csrf-token"))
    with pytest.raises(HTTPException) as invalid:
        auth_router.logout(refresh_only, db)
    assert invalid.value.status_code == 401
    assert db.rollback.call_count == 1


def test_session_and_session_management_routes_distinguish_setup_and_current_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user = _user()
    current = IdentitySession(
        id=uuid7(),
        user_id=user.id,
        refresh_token_digest="digest",
        csrf_token_digest="csrf",
        expires_at=datetime.now(UTC) + timedelta(days=1),
    )
    other = IdentitySession(
        id=uuid7(),
        user_id=user.id,
        refresh_token_digest="digest",
        csrf_token_digest="csrf",
        expires_at=datetime.now(UTC) + timedelta(days=1),
    )
    identity = CurrentIdentity(user, current.id, True, False)
    monkeypatch.setattr(auth_router, "get_current_identity", Mock(side_effect=HTTPException(401)))
    assert auth_router.session_status(_request(method="GET", origin=None), db) == {
        "authenticated": False
    }
    monkeypatch.setattr(auth_router, "get_current_identity", Mock(return_value=identity))
    assert auth_router.session_status(_request(method="GET", origin=None), db)["user_id"] == user.id
    db.scalars.return_value.all.return_value = [current, other]
    sessions = sessions_router.list_sessions(identity, db)
    assert [item["current"] for item in sessions] == [True, False]
    response = Response()
    monkeypatch.setattr(auth_router, "revoke_session", Mock(return_value=True))
    assert auth_router.revoke_one_session(current.id, identity, response, db) is response
    assert response.status_code == 204
    assert any('openslate_access=""' in item for item in response.headers.getlist("set-cookie"))
    monkeypatch.setattr(auth_router, "revoke_user_sessions", Mock())
    assert auth_router.revoke_other_sessions(identity, Response(), db).status_code == 204

    setup_identity = CurrentIdentity(user, current.id, True, True)
    with pytest.raises(HTTPException) as setup_denied:
        sessions_router.list_sessions(setup_identity, db)
    assert setup_denied.value.status_code == 401


def test_change_password_maps_safe_error_outcomes_and_rotates_browser_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user = _user()
    identity = CurrentIdentity(user, uuid7(), True, False)
    payload = PasswordChangeRequest(
        current_password="old password", password="new sufficiently long password"
    )
    monkeypatch.setattr(auth_router, "authenticate_password", Mock(return_value=user))
    monkeypatch.setattr(auth_router, "replace_password", Mock())
    monkeypatch.setattr(auth_router, "issue_session", Mock(return_value=_issued()))
    response = Response()

    assert auth_router.change_password(payload, identity, _request(), response, db) == {
        "authenticated": True,
        "setup_required": False,
    }
    assert _cookie_contains(response, "openslate_access=access-token")

    monkeypatch.setattr(
        auth_router, "authenticate_password", Mock(side_effect=IdentityRateLimited("blocked"))
    )
    with pytest.raises(HTTPException) as limited:
        auth_router.change_password(payload, identity, _request(), Response(), db)
    assert limited.value.status_code == 429
    monkeypatch.setattr(
        auth_router, "authenticate_password", Mock(side_effect=InvalidCredentials("bad"))
    )
    with pytest.raises(HTTPException) as invalid:
        auth_router.change_password(payload, identity, _request(), Response(), db)
    assert invalid.value.status_code == 403
    monkeypatch.setattr(auth_router, "authenticate_password", Mock(return_value=user))
    monkeypatch.setattr(auth_router, "replace_password", Mock(side_effect=ValueError("policy")))
    with pytest.raises(HTTPException) as rejected:
        auth_router.change_password(payload, identity, _request(), Response(), db)
    assert rejected.value.status_code == 403
