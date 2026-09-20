"""HTTP-handler contracts for the local Identity boundary.

These tests keep authentication decisions at the router and dependency boundary:
they prove public response behavior, cookie clearing, CSRF transport, and safe
error mapping without recreating the identity service's unit tests.
"""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, Request, Response
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.common.dependencies.auth as dependencies
import app.systems.access.auth.router as auth_router
from app.common.dependencies.auth import CurrentIdentity
from app.systems.access.identity.models import ActionTokenPurpose, IdentitySession
from app.systems.access.identity.schemas import (
    ActionTokenCompleteRequest,
    LoginRequest,
    PasswordChangeRequest,
    RecoveryRequest,
    RefreshTokenRequest,
)
from app.systems.access.identity.service import (
    ActionTokenInvalid,
    IdentityRateLimited,
    InvalidCredentials,
    IssuedSession,
    RefreshReplayDetected,
)
from app.systems.access.users.models import Role, User, UserRole, UserStatus


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


def _settings() -> SimpleNamespace:
    return SimpleNamespace(cors_origins=["https://app.example.test"])


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


@pytest.fixture(autouse=True)
def _allowed_origin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth_router, "get_settings", _settings)


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

    monkeypatch.setattr(auth_router, "refresh_session", Mock(side_effect=InvalidCredentials("bad")))
    invalid = auth_router.refresh(request, Response(), db)
    assert invalid.status_code == 401
    assert db.rollback.call_count == 1


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
    sessions = auth_router.list_sessions(identity, db)
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
        auth_router.list_sessions(setup_identity, db)
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


def test_recovery_and_invitation_completion_only_commit_valid_action_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user = _user()
    action = SimpleNamespace(user_id=user.id)
    payload = ActionTokenCompleteRequest(token="x" * 32, password="new sufficiently long password")
    monkeypatch.setattr(auth_router, "consume_action_token", Mock(return_value=action))
    monkeypatch.setattr(auth_router, "replace_password", Mock())
    monkeypatch.setattr(auth_router, "begin_invitation_acceptance", lambda *_args: uuid7())
    monkeypatch.setattr(auth_router, "append_invitation_acceptance_success", lambda *_args: None)
    monkeypatch.setattr(auth_router, "record_invitation_acceptance_failure", lambda *_args: None)
    db.get.return_value = user

    assert auth_router.complete_recovery(payload, _request(), db).status_code == 204
    user.status = UserStatus.PENDING.value
    assert auth_router.complete_invitation(payload, _request(), db).status_code == 204
    assert user.status == UserStatus.ACTIVE.value
    assert user.invitation_accepted_at is not None
    assert db.commit.call_count == 2

    monkeypatch.setattr(
        auth_router, "consume_action_token", Mock(side_effect=ActionTokenInvalid("bad"))
    )
    with pytest.raises(HTTPException) as recovery_invalid:
        auth_router.complete_recovery(payload, _request(), db)
    with pytest.raises(HTTPException) as invitation_invalid:
        auth_router.complete_invitation(payload, _request(), db)
    assert recovery_invalid.value.status_code == 400
    assert invitation_invalid.value.status_code == 400
    assert db.rollback.call_count == 2


def test_invitation_completion_records_attempt_and_commits_success_with_activation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user = _user(status=UserStatus.PENDING)
    action = SimpleNamespace(user_id=user.id)
    payload = ActionTokenCompleteRequest(token="x" * 32, password="new sufficiently long password")
    events: list[str] = []
    monkeypatch.setattr(auth_router, "consume_action_token", Mock(return_value=action))
    monkeypatch.setattr(auth_router, "replace_password", Mock())
    monkeypatch.setattr(
        auth_router,
        "begin_invitation_acceptance",
        lambda *_args: events.append("attempt") or uuid7(),
    )
    monkeypatch.setattr(
        auth_router,
        "append_invitation_acceptance_success",
        lambda *_args: events.append("success"),
    )
    monkeypatch.setattr(
        auth_router,
        "record_invitation_acceptance_failure",
        lambda *_args, **_kwargs: events.append("failure"),
    )
    db.get.return_value = user
    db.commit.side_effect = lambda: events.append("commit")

    assert auth_router.complete_invitation(payload, _request(), db).status_code == 204
    assert user.status == UserStatus.ACTIVE.value
    assert events == ["attempt", "success", "commit"]


def test_invitation_completion_records_attempt_and_failure_for_an_invalid_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    payload = ActionTokenCompleteRequest(token="x" * 32, password="new sufficiently long password")
    events: list[str] = []
    monkeypatch.setattr(
        auth_router,
        "begin_invitation_acceptance",
        lambda *_args: events.append("attempt") or uuid7(),
    )
    monkeypatch.setattr(
        auth_router,
        "record_invitation_acceptance_failure",
        lambda *_args, **_kwargs: events.append("failure"),
    )
    monkeypatch.setattr(
        auth_router,
        "consume_action_token",
        Mock(side_effect=ActionTokenInvalid("invalid")),
    )

    with pytest.raises(HTTPException) as error:
        auth_router.complete_invitation(payload, _request(), db)

    assert error.value.status_code == 400
    assert events == ["attempt", "failure"]


def test_invitation_completion_records_failure_when_activation_cannot_commit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user = _user(status=UserStatus.PENDING)
    action = SimpleNamespace(user_id=user.id)
    payload = ActionTokenCompleteRequest(token="x" * 32, password="new sufficiently long password")
    events: list[str] = []
    monkeypatch.setattr(auth_router, "consume_action_token", Mock(return_value=action))
    monkeypatch.setattr(auth_router, "replace_password", Mock())
    monkeypatch.setattr(
        auth_router,
        "begin_invitation_acceptance",
        lambda *_args: events.append("attempt") or uuid7(),
    )
    monkeypatch.setattr(
        auth_router,
        "append_invitation_acceptance_success",
        lambda *_args: events.append("success"),
    )
    monkeypatch.setattr(
        auth_router,
        "record_invitation_acceptance_failure",
        lambda *_args, **_kwargs: events.append("failure"),
    )
    db.get.return_value = user
    db.commit.side_effect = SQLAlchemyError("database unavailable")

    with pytest.raises(HTTPException) as error:
        auth_router.complete_invitation(payload, _request(), db)

    assert error.value.status_code == 503
    assert events == ["attempt", "success", "failure"]
    db.rollback.assert_called_once()


def test_recovery_completion_rejects_a_disabled_user_after_consuming_the_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user = _user()
    user.status = UserStatus.DISABLED.value
    action = SimpleNamespace(user_id=user.id)
    payload = ActionTokenCompleteRequest(token="x" * 32, password="new sufficiently long password")
    monkeypatch.setattr(auth_router, "consume_action_token", Mock(return_value=action))
    db.get.return_value = user

    with pytest.raises(HTTPException) as error:
        auth_router.complete_recovery(payload, _request(), db)

    assert error.value.status_code == 400
    db.rollback.assert_called_once()


def test_recovery_request_has_identical_success_response_for_known_and_unknown_users(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    db.info = {}
    user = _user()
    payload = RecoveryRequest(identifier=" Person@Example.Test ")
    db.scalar.return_value = user
    monkeypatch.setattr(auth_router, "smtp_delivery_enabled", lambda: True)
    monkeypatch.setattr(auth_router, "recovery_request_permitted", lambda *_args, **_kwargs: True)
    issue = Mock(return_value="recovery-token")
    queue = Mock()
    monkeypatch.setattr(auth_router, "issue_action_token", issue)
    monkeypatch.setattr(auth_router, "queue_action_delivery", queue)

    assert auth_router.request_recovery(payload, _request(), db).status_code == 204
    issue.assert_called_once_with(db, user.id, ActionTokenPurpose.RECOVERY)
    queue.assert_called_once_with(db, user.id, ActionTokenPurpose.RECOVERY, "recovery-token")
    db.scalar.return_value = None
    assert auth_router.request_recovery(payload, _request(), db).status_code == 204
    assert issue.call_count == 1
    assert db.commit.call_count == 2


def test_current_identity_validates_one_transport_and_cookie_mutation_csrf(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    db.info = {}
    user = _user()
    session_id = uuid7()
    claims = {"sub": str(user.id), "sid": str(session_id)}
    monkeypatch.setattr(dependencies, "decode_token", lambda *_args: claims)
    monkeypatch.setattr(dependencies, "validate_access_session", lambda *_args, **_kwargs: user)
    actor = Mock()
    monkeypatch.setattr(dependencies, "set_audit_actor", actor)

    identity = dependencies.get_current_identity(
        _request(origin=None, authorization="Bearer access-token"),
        SimpleNamespace(credentials="access-token"),
        db,
    )
    assert identity.user is user and not identity.cookie_authenticated
    actor.assert_called_once_with(db, user.id)

    with pytest.raises(HTTPException) as mixed:
        dependencies.get_current_identity(
            _request(cookies="openslate_access=cookie", authorization="Bearer access-token"),
            SimpleNamespace(credentials="access-token"),
            db,
        )
    assert mixed.value.status_code == 401

    cookie_request = _request(cookies="openslate_access=cookie")
    cookie_request.scope["headers"].append((b"x-csrf-token", b"csrf-token"))
    db.get.return_value = SimpleNamespace(csrf_token_digest="digest")
    monkeypatch.setattr(dependencies, "validate_csrf", lambda *_args: False)
    with pytest.raises(HTTPException) as csrf:
        dependencies.get_current_identity(cookie_request, None, db)
    assert csrf.value.status_code == 401


def test_dependency_authorization_fails_closed_for_stale_admin_and_setup_identity() -> None:
    setup = CurrentIdentity(_user(), uuid7(), False, True)
    with pytest.raises(HTTPException) as setup_denied:
        dependencies.get_current_user(setup)
    assert setup_denied.value.status_code == 401

    admin_role = _role(UserRole.ADMIN)
    actor = _user(role=admin_role)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, actor]
    assert dependencies.require_fresh_exact_admin(db, actor.id) is actor

    db.scalar.side_effect = SQLAlchemyError("database unavailable")
    with pytest.raises(HTTPException) as unavailable:
        dependencies.require_fresh_exact_admin(db, actor.id)
    assert unavailable.value.status_code == 503

    assert dependencies.require_roles(UserRole.ADMIN)(actor) is actor
    with pytest.raises(HTTPException) as denied:
        dependencies.require_roles(UserRole.ADMIN)(_user())
    assert denied.value.status_code == 403
