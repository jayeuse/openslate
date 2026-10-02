"""Real-provider HTTP acceptance for password change and local session policy."""

from secrets import token_urlsafe
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User

pytest_plugins = ("tests.auth.test_provider_auth_integration",)
pytestmark = pytest.mark.integration


def _owned_session_states(owner, local_user_id: UUID) -> dict[UUID, tuple[bool, bool]]:
    with Session(owner) as db:
        sessions = db.scalars(
            select(IdentitySession).where(IdentitySession.user_id == local_user_id)
        ).all()
        return {
            session.id: (
                session.revoked_at is None,
                session.provider_signout_pending_at is not None,
            )
            for session in sessions
        }


def _current_session_id(client: TestClient) -> UUID:
    response = client.get("/api/auth/sessions")
    assert response.status_code == 200, "Authenticated session inventory must load"
    current = [UUID(item["id"]) for item in response.json() if item["current"]]
    assert len(current) == 1, "Each browser must resolve to exactly one current app session"
    return current[0]


def _browser_client(origin: str) -> TestClient:
    client = TestClient(create_app(), base_url=origin)
    client.headers["Origin"] = origin
    return client


def test_password_change_retains_current_and_revokes_other_provider_sessions(provider_account):
    email, old_password, provider_id, local_user_id, owner = provider_account
    origin = str(get_settings().public_origin)
    clients: list[TestClient] = []

    def new_browser() -> TestClient:
        client = _browser_client(origin)
        clients.append(client)
        return client

    current = new_browser()
    other = new_browser()
    try:
        with Session(owner) as db:
            user = db.get(User, local_user_id)
            assert user is not None, "Owned local profile must exist"
            assert user.supabase_user_id is None, "Provider fixture must begin unbound"
            user.supabase_user_id = provider_id
            db.commit()

        for client in (current, other):
            login = client.post("/api/auth/login", json={"email": email, "password": old_password})
            assert login.status_code == 200, (
                "Real Supabase email login must admit the bound profile"
            )
            assert client.get("/api/auth/me").status_code == 200

        current_session_id = _current_session_id(current)
        other_session_id = _current_session_id(other)
        assert current_session_id != other_session_id, (
            "Separate logins must create separate app sessions"
        )
        before_wrong_password = _owned_session_states(owner, local_user_id)
        assert set(before_wrong_password) == {current_session_id, other_session_id}
        assert all(state == (True, False) for state in before_wrong_password.values())

        csrf = current.cookies.get("openslate_csrf")
        assert csrf is not None, "Browser login must provide its CSRF token"
        weak = current.post(
            "/api/auth/password/change",
            json={"current_password": old_password, "password": "no uppercase password"},
            headers={"X-CSRF-Token": csrf},
        )
        assert weak.status_code == 422
        assert weak.json()["detail"]["code"] == "password_policy_violation"
        assert _owned_session_states(owner, local_user_id) == before_wrong_password
        new_password = token_urlsafe(32)
        wrong_password = token_urlsafe(32)
        denied = current.post(
            "/api/auth/password/change",
            json={"current_password": wrong_password, "password": new_password},
            headers={"X-CSRF-Token": csrf},
        )
        assert denied.status_code == 403, "Wrong current password must deny the change"
        assert _owned_session_states(owner, local_user_id) == before_wrong_password, (
            "A denied password change must leave both app sessions active"
        )
        assert current.get("/api/auth/me").status_code == 200
        assert other.get("/api/auth/me").status_code == 200

        old_password_probe = new_browser()
        old_login = old_password_probe.post(
            "/api/auth/login", json={"email": email, "password": old_password}
        )
        assert old_login.status_code == 200, "Failed step-up must leave the old password usable"
        probe_session_id = _current_session_id(old_password_probe)

        changed = current.post(
            "/api/auth/password/change",
            json={"current_password": old_password, "password": new_password},
            headers={"X-CSRF-Token": csrf},
        )
        assert changed.status_code == 200, (
            "Correct current password must update the provider password"
        )

        after_change = _owned_session_states(owner, local_user_id)
        assert set(after_change) == {current_session_id, other_session_id, probe_session_id}
        assert after_change[current_session_id] == (True, False), (
            "Password change must retain the current application session"
        )
        assert after_change[other_session_id] == (False, True), (
            "Password change must revoke the other admitted application session"
        )
        assert after_change[probe_session_id] == (False, True), (
            "Password change must revoke every other active application session"
        )
        assert current.get("/api/auth/me").status_code == 200
        assert other.get("/api/auth/me").status_code == 401
        assert old_password_probe.get("/api/auth/me").status_code == 401

        refreshed = current.post("/api/auth/refresh", headers={"X-CSRF-Token": csrf})
        assert refreshed.status_code == 200, "Retained browser session must still refresh"
        assert current.get("/api/auth/me").status_code == 200

        old_login_after_change = new_browser().post(
            "/api/auth/login", json={"email": email, "password": old_password}
        )
        assert old_login_after_change.status_code == 401, "Old provider password must stop working"
        new_login_client = new_browser()
        new_login = new_login_client.post(
            "/api/auth/login", json={"email": email, "password": new_password}
        )
        assert new_login.status_code == 200, "New provider password must admit a fresh app session"
        assert new_login_client.get("/api/auth/me").status_code == 200
    finally:
        for client in clients:
            client.close()
