"""HTTP-handler contracts for the Supabase-backed Identity boundary.

These tests keep authentication decisions at the router and dependency boundary:
they prove public response behavior, cookie clearing, CSRF transport, and safe
error mapping without recreating the identity service's unit tests.
"""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, Response
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.auth.router as auth_router
import app.systems.access.users.sessions_router as sessions_router
from app.common.dependencies.auth import CurrentIdentity
from app.core.integrations.supabase_auth import SupabaseAuthUnavailable
from app.systems.access.identity.contracts import (
    IdentityRateLimited,
    InvalidCredentials,
    IssuedSession,
)
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.schemas import (
    LoginRequest,
    PasswordChangeRequest,
    RefreshTokenRequest,
)
from tests.auth.local_identity_support import contract_request, contract_user


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
    client = Mock()
    monkeypatch.setattr(auth_router, "get_supabase_auth_client", lambda: client, raising=False)
    monkeypatch.setattr(
        auth_router, "login_with_provider", Mock(return_value=_issued()), raising=False
    )
    payload = LoginRequest(email="person@example.test", password="correct password")

    response = Response()
    result = auth_router.login(payload, contract_request(), response, db)

    assert result == {"authenticated": True, "setup_required": False}
    assert db.commit.call_count == 1
    assert _cookie_contains(response, "openslate_access=access-token")
    assert _cookie_contains(response, "openslate_refresh=refresh-token")

    monkeypatch.setattr(
        auth_router, "login_with_provider", Mock(side_effect=InvalidCredentials("bad"))
    )
    with pytest.raises(HTTPException) as invalid:
        auth_router.login(payload, contract_request(), Response(), db)
    assert invalid.value.status_code == 401
    assert db.commit.call_count == 2

    monkeypatch.setattr(
        auth_router, "login_with_provider", Mock(side_effect=IdentityRateLimited("blocked"))
    )
    with pytest.raises(HTTPException) as rate_limited:
        auth_router.login(payload, contract_request(), Response(), db)
    assert rate_limited.value.status_code == 429
    assert rate_limited.value.headers == {"Retry-After": "900"}
    db.rollback.assert_called_once()

    monkeypatch.setattr(
        auth_router, "login_with_provider", Mock(side_effect=SupabaseAuthUnavailable("offline"))
    )
    with pytest.raises(HTTPException) as unavailable:
        auth_router.login(payload, contract_request(), Response(), db)
    assert unavailable.value.status_code == 503


def test_refresh_browser_session_enforces_cookie_csrf_and_clears_invalid_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    no_cookie = contract_request()
    with pytest.raises(HTTPException) as missing:
        auth_router.refresh(no_cookie, Response(), db)
    assert missing.value.status_code == 401

    request = contract_request(cookies="openslate_refresh=old-refresh")
    request.scope["headers"].append((b"x-csrf-token", b"csrf-token"))
    monkeypatch.setattr(auth_router, "get_supabase_auth_client", lambda: Mock())
    monkeypatch.setattr(auth_router, "refresh_provider_session", Mock(return_value=_issued()))
    response = Response()
    assert auth_router.refresh(request, response, db) == {
        "authenticated": True,
        "setup_required": False,
    }
    db.commit.assert_not_called()
    assert _cookie_contains(response, "openslate_access=access-token")

    monkeypatch.setattr(
        auth_router, "refresh_provider_session", Mock(side_effect=InvalidCredentials("revoked"))
    )
    replay = auth_router.refresh(request, Response(), db)
    assert replay.status_code == 401
    assert any('openslate_refresh=""' in item for item in replay.headers.getlist("set-cookie"))

    monkeypatch.setattr(
        auth_router,
        "refresh_provider_session",
        Mock(side_effect=SupabaseAuthUnavailable("offline")),
    )
    with pytest.raises(HTTPException) as unavailable:
        auth_router.refresh(request, Response(), db)
    assert unavailable.value.status_code == 503


def test_bearer_token_routes_reject_mixed_setup_replay_and_invalid_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    payload = LoginRequest(email="person@example.test", password="correct password")
    client = Mock()
    monkeypatch.setattr(auth_router, "get_supabase_auth_client", lambda: client)
    monkeypatch.setattr(auth_router, "login_with_provider", Mock(return_value=_issued()))

    issued = auth_router.issue_bearer_token(payload, contract_request(origin=None), db)
    assert issued.access_token == "access-token" and issued.refresh_token == "refresh-token"
    db.commit.assert_called_once()

    monkeypatch.setattr(
        auth_router, "login_with_provider", Mock(side_effect=IdentityRateLimited("blocked"))
    )
    with pytest.raises(HTTPException) as throttled:
        auth_router.issue_bearer_token(payload, contract_request(origin=None), db)
    assert throttled.value.status_code == 429
    assert throttled.value.headers == {"Retry-After": "900"}

    monkeypatch.setattr(
        auth_router, "login_with_provider", Mock(side_effect=InvalidCredentials("bad"))
    )
    with pytest.raises(HTTPException) as invalid_login:
        auth_router.issue_bearer_token(payload, contract_request(origin=None), db)
    assert invalid_login.value.status_code == 401

    refresh = RefreshTokenRequest(refresh_token="x" * 32)
    monkeypatch.setattr(
        auth_router, "refresh_provider_session", Mock(return_value=_issued()), raising=False
    )
    refreshed = auth_router.refresh_bearer_token(refresh, contract_request(origin=None), db)
    assert refreshed.token_type == "bearer"
    monkeypatch.setattr(
        auth_router, "refresh_provider_session", Mock(side_effect=InvalidCredentials("revoked"))
    )
    with pytest.raises(HTTPException) as revoked:
        auth_router.refresh_bearer_token(refresh, contract_request(origin=None), db)
    assert revoked.value.status_code == 401
    monkeypatch.setattr(
        auth_router,
        "refresh_provider_session",
        Mock(side_effect=SupabaseAuthUnavailable("offline")),
    )
    with pytest.raises(HTTPException) as unavailable_refresh:
        auth_router.refresh_bearer_token(refresh, contract_request(origin=None), db)
    assert unavailable_refresh.value.status_code == 503


def test_password_change_requires_the_current_access_credential(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user, _membership = contract_user()
    identity = CurrentIdentity(user, uuid7(), True, False)
    change = Mock()
    monkeypatch.setattr(auth_router.provider_actions, "change_password", change)
    payload = PasswordChangeRequest(
        current_password="current password", password="new sufficiently long password"
    )
    with pytest.raises(HTTPException) as error:
        auth_router.change_password(payload, identity, contract_request(), Response(), db)
    assert error.value.status_code == 401
    change.assert_not_called()


@pytest.mark.parametrize("account_status,delivery", [("active", "in_app"), ("pending", "email")])
@pytest.mark.parametrize("route", ["legacy", "invite", "resend"])
def test_invitation_responses_project_pending_membership_and_actual_delivery(
    monkeypatch, account_status, delivery, route
):
    from app.systems.access.users import router as users_router
    from app.systems.access.users.schemas import (
        InvitationCreate,
        InvitationResendRequest,
        UserCreate,
    )

    admin, _ = contract_user()
    user, membership = contract_user()
    user.status, membership.status = account_status, "pending"
    db = Mock(spec=Session)
    db.dirty = set()
    db.scalars.return_value.all.return_value = [membership]
    db.scalars.return_value.one.return_value = membership
    target = users_router if route == "legacy" else auth_router
    monkeypatch.setattr(target, "invite_user", Mock(return_value=user))
    monkeypatch.setattr(auth_router, "resend_invitation", Mock(return_value=user))
    payload = {"email": user.email, "username": user.username}
    result = (
        users_router.create_user(UserCreate(**payload), admin, db) if route == "legacy" else
        auth_router.invite(InvitationCreate(**payload), admin, db) if route == "invite" else
        auth_router.resend_invite(user.id, InvitationResendRequest(), admin, db)
    )
    assert result.user.status.value == "pending"
    assert result.delivery == delivery
    assert user.status == account_status


def test_invalid_bearer_refresh_does_not_roll_back_provider_owned_revocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    monkeypatch.setattr(auth_router, "get_supabase_auth_client", lambda: Mock())
    monkeypatch.setattr(
        auth_router, "refresh_provider_session", Mock(side_effect=InvalidCredentials("revoked"))
    )
    with pytest.raises(HTTPException) as error:
        auth_router.refresh_bearer_token(
            RefreshTokenRequest(refresh_token="x" * 32), contract_request(origin=None), db
        )
    assert error.value.status_code == 401
    db.rollback.assert_not_called()


def test_logout_rejects_bad_refresh_but_clears_a_valid_browser_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user, _membership = contract_user()
    identity = CurrentIdentity(user, uuid7(), True, False)
    request = contract_request(cookies="openslate_access=access; openslate_refresh=refresh")
    request.scope["headers"].append((b"x-csrf-token", b"csrf-token"))
    lookup = Mock(return_value=identity)
    monkeypatch.setattr(auth_router, "get_mfa_identity", lookup)
    revoke = Mock(return_value=identity.session_id)
    monkeypatch.setattr(auth_router, "revoke_provider_refresh_session", revoke)
    client = Mock()
    monkeypatch.setattr(auth_router, "get_supabase_auth_client", lambda: client)
    signout = Mock(return_value=True)
    monkeypatch.setattr(auth_router, "attempt_provider_signout", signout, raising=False)

    response = auth_router.logout(request, db)

    assert response.status_code == 204
    revoke.assert_called_once_with(db, "refresh", csrf_token="csrf-token")
    lookup.assert_not_called()
    assert any('openslate_access=""' in item for item in response.headers.getlist("set-cookie"))
    db.commit.assert_called_once()
    signout.assert_called_once_with(db, identity.session_id, client)

    monkeypatch.setattr(auth_router, "get_mfa_identity", Mock(side_effect=HTTPException(401)))
    monkeypatch.setattr(
        auth_router, "revoke_provider_refresh_session", Mock(return_value=None), raising=False
    )
    refresh_only = contract_request(cookies="openslate_refresh=" + "r" * 48)
    refresh_only.scope["headers"].append((b"x-csrf-token", b"csrf-token"))
    with pytest.raises(HTTPException) as invalid:
        auth_router.logout(refresh_only, db)
    assert invalid.value.status_code == 401
    assert db.rollback.call_count == 1

    monkeypatch.setattr(
        auth_router, "revoke_provider_refresh_session", Mock(return_value=identity.session_id)
    )
    signed_out = auth_router.logout(refresh_only, db)
    assert signed_out.status_code == 204
    assert signout.call_count == 2


def test_session_and_session_management_routes_distinguish_setup_and_current_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.common.dependencies.auth import AccountOrganization
    from app.systems.access.auth import organization_router

    db = Mock(spec=Session)
    user, _membership = contract_user()
    created_at = datetime.now(UTC)
    current = IdentitySession(
        id=uuid7(),
        user_id=user.id,
        refresh_token_digest="digest",
        csrf_token_digest="csrf",
        created_at=created_at,
        refreshed_at=created_at,
        expires_at=datetime.now(UTC) + timedelta(days=1),
    )
    other = IdentitySession(
        id=uuid7(),
        user_id=user.id,
        refresh_token_digest="digest",
        csrf_token_digest="csrf",
        created_at=created_at,
        refreshed_at=created_at,
        expires_at=datetime.now(UTC) + timedelta(days=1),
    )
    identity = CurrentIdentity(user, current.id, True, False)
    monkeypatch.setattr(organization_router, "get_account_identity",
                        Mock(side_effect=HTTPException(401)))
    assert organization_router.session_status(contract_request(method="GET", origin=None), db) == {
        "authenticated": False
    }
    monkeypatch.setattr(organization_router, "get_account_identity",
                        Mock(side_effect=HTTPException(503)))
    with pytest.raises(HTTPException) as unavailable:
        organization_router.session_status(contract_request(method="GET", origin=None), db)
    assert unavailable.value.status_code == 503
    monkeypatch.setattr(organization_router, "get_account_identity", Mock(return_value=identity))
    monkeypatch.setattr(
        organization_router, "get_account_organization",
        Mock(return_value=AccountOrganization(_membership)),
    )
    assert (
        organization_router.session_status(
            contract_request(method="GET", origin=None), db
        )["user_id"]
        == user.id
    )
    db.scalars.return_value.all.return_value = [current, other]
    sessions = sessions_router.list_sessions(identity, db)
    assert [item.current for item in sessions] == [True, False]
    response = Response()
    monkeypatch.setattr(sessions_router, "append_security_event", Mock())
    monkeypatch.setattr(sessions_router, "revoke_session", Mock(return_value=True))
    assert sessions_router.revoke_one_session(current.id, identity, response, db) is response
    assert response.status_code == 204
    assert any('openslate_access=""' in item for item in response.headers.getlist("set-cookie"))
    monkeypatch.setattr(sessions_router, "revoke_user_sessions", Mock(return_value=1))
    assert sessions_router.revoke_other_sessions(identity, Response(), db).status_code == 204

    setup_identity = CurrentIdentity(user, current.id, True, True)
    with pytest.raises(HTTPException) as setup_denied:
        sessions_router.list_sessions(setup_identity, db)
    assert setup_denied.value.status_code == 401


@pytest.mark.parametrize("end_others", (False, True))
def test_self_session_end_records_one_redacted_event_only_when_state_changes(
    monkeypatch: pytest.MonkeyPatch, end_others: bool
) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.common.dependencies.auth import get_account_identity
    from app.core.database import get_db
    from app.systems.access.auth.aggregate_router import router

    db = Mock(spec=Session)
    user, _membership = contract_user()
    timestamp = datetime.now(UTC)
    current = IdentitySession(id=uuid7(), user_id=user.id, revoked_at=None)
    other = IdentitySession(id=uuid7(), user_id=user.id, revoked_at=None)
    db.get.return_value = other
    db.scalars.return_value = [current, other]
    record_event = Mock()
    monkeypatch.setattr(sessions_router, "append_security_event", record_event)
    identity = CurrentIdentity(user, current.id, False, False)
    application = FastAPI()
    application.include_router(router, prefix="/api")
    application.dependency_overrides[get_db] = lambda: db
    application.dependency_overrides[get_account_identity] = lambda: identity
    path = "/api/auth/sessions/revoke-others" if end_others else f"/api/auth/sessions/{other.id}"
    with TestClient(application, raise_server_exceptions=False) as client:
        first = client.request("POST" if end_others else "DELETE", path)
        second = client.request("POST" if end_others else "DELETE", path)
    assert first.status_code == second.status_code == 204
    assert current.revoked_at is None
    assert other.revoked_at is not None and other.revoked_at >= timestamp
    record_event.assert_called_once()
    event = record_event.call_args.args[1]
    assert event.event_type == "identity.session_revocation"
    assert event.actor_id == event.subject_id == user.id
    assert event.labels == {"scope": "others" if end_others else "one"}
    assert event.metadata == {}
    application.dependency_overrides.clear()


def test_change_password_maps_safe_provider_errors_and_preserves_current_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user, _membership = contract_user()
    identity = CurrentIdentity(user, uuid7(), True, False)
    payload = PasswordChangeRequest(
        current_password="old password", password="new sufficiently long password"
    )
    monkeypatch.setattr(auth_router, "get_supabase_auth_client", lambda: Mock())
    change = Mock()
    monkeypatch.setattr(auth_router.provider_actions, "change_password", change)
    response = Response()
    request = contract_request(cookies="openslate_access=current-access")
    assert auth_router.change_password(payload, identity, request, response, db) == {
        "authenticated": True,
        "setup_required": False,
    }
    # Provider password change retains the admitted current session; other sessions
    # are revoked by the provider action, covered at that boundary.
    assert response.headers.getlist("set-cookie") == []
    for failure, expected in (
        (IdentityRateLimited("private rate detail"), 429),
        (InvalidCredentials("private credential detail"), 403),
        (SupabaseAuthUnavailable("private upstream detail"), 503),
    ):
        change.side_effect = failure
        with pytest.raises(HTTPException) as rejected:
            auth_router.change_password(payload, identity, request, Response(), db)
        assert rejected.value.status_code == expected
        assert "private" not in str(rejected.value.detail)
    assert db.rollback.call_count == 3

    # A spent sign-in budget reports its remaining wait, as the sign-in routes do.
    change.side_effect = IdentityRateLimited("private rate detail", retry_after=180)
    with pytest.raises(HTTPException) as throttled:
        auth_router.change_password(payload, identity, request, Response(), db)
    assert throttled.value.status_code == 429
    assert throttled.value.headers == {"Retry-After": "180"}
