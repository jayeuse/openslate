"""Real-provider HTTP acceptance for password change and local session policy."""

from secrets import token_urlsafe
from threading import Event
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

import app.systems.access.auth.router as auth_router
from app.core.config import get_settings
from app.core.database.session import get_engine
from app.core.integrations.supabase_auth import get_supabase_auth_client
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.coordination import lock_user
from app.systems.access.users.models import User, UserStatus
from tests.race_support import WAIT, StatementPause, join, start, wait_until_blocked_by

pytest_plugins = ("tests.auth.provider_account_support",)
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


def test_an_account_disabled_after_the_provider_grant_keeps_its_password(
    provider_account, monkeypatch: pytest.MonkeyPatch
):
    email, old_password, provider_id, local_user_id, owner = provider_account
    with Session(owner) as db:
        user = db.get(User, local_user_id)
        assert user is not None
        user.supabase_user_id = provider_id
        db.commit()
    browser = _browser_client(str(get_settings().public_origin))
    real = get_supabase_auth_client()
    raced: list[bool] = []

    class DisableAfterGrant:
        """The real provider client; an administrator disables the account right after
        the provider accepts the current password, before the change locks the profile."""

        def __getattr__(self, name: str):
            return getattr(real, name)

        def password_grant(self, grant_email: str, password: str):
            tokens = real.password_grant(grant_email, password)
            with Session(owner) as db:
                target = db.get(User, local_user_id)
                assert target is not None
                target.status = UserStatus.DISABLED.value
                db.commit()
            raced.append(True)
            return tokens

    try:
        login = browser.post("/api/auth/login", json={"email": email, "password": old_password})
        assert login.status_code == 200, login.text
        csrf = browser.cookies.get("openslate_csrf")
        assert csrf is not None
        monkeypatch.setattr(auth_router, "get_supabase_auth_client", DisableAfterGrant)

        changed = browser.post(
            "/api/auth/password/change",
            json={"current_password": old_password, "password": token_urlsafe(32)},
            headers={"X-CSRF-Token": csrf},
        )

        assert raced == [True]
        assert changed.status_code == 403
        assert changed.json() == {"detail": "Password cannot be changed"}
        # The provider still holds the old password.
        tokens = real.password_grant(email, old_password)
        real.sign_out(tokens.access_token, scope="local")
    finally:
        browser.close()


def test_a_disable_after_the_password_change_locks_the_profile_waits_for_the_change(
    provider_account, monkeypatch: pytest.MonkeyPatch
):
    email, old_password, provider_id, local_user_id, owner = provider_account
    with Session(owner) as db:
        user = db.get(User, local_user_id)
        assert user is not None
        user.supabase_user_id = provider_id
        db.commit()
    browser = _browser_client(str(get_settings().public_origin))
    real = get_supabase_auth_client()
    holds: list[StatementPause] = []
    held = Event()

    class HoldAfterProviderUpdate:
        """The real provider client. Once the provider has the new password, the change's
        next statement (its session revocation) is held while the change keeps its lock."""

        def __getattr__(self, name: str):
            return getattr(real, name)

        def update_password(self, access_token: str, password: str):
            changed = real.update_password(access_token, password)
            holds.append(StatementPause(get_engine(), "SELECT"))
            held.set()
            return changed

    def disable() -> None:
        # The lock and the status change of an administrator's disable.
        with Session(owner) as db:
            lock_user(db, local_user_id).status = UserStatus.DISABLED.value
            db.commit()

    new_password = token_urlsafe(32)
    try:
        login = browser.post("/api/auth/login", json={"email": email, "password": old_password})
        assert login.status_code == 200, login.text
        csrf = browser.cookies.get("openslate_csrf")
        assert csrf is not None
        monkeypatch.setattr(auth_router, "get_supabase_auth_client", HoldAfterProviderUpdate)
        change_thread, change_result = start(
            lambda: browser.post(
                "/api/auth/password/change",
                json={"current_password": old_password, "password": new_password},
                headers={"X-CSRF-Token": csrf},
            )
        )
        disable_thread, disable_result = None, []
        try:
            assert held.wait(WAIT) and holds[0].paused.wait(WAIT)
            disable_thread, disable_result = start(disable)
            wait_until_blocked_by(owner, holds[0].holder_pid)
            assert disable_thread.is_alive()
        finally:
            # Release first; remove the listener only after both requests finished,
            # because removal mutates the engine's listener list.
            for hold in holds:
                hold.release.set()
            change_thread.join(WAIT)
            if disable_thread is not None:
                disable_thread.join(WAIT)
            for hold in holds:
                hold.remove()
        assert disable_thread is not None
        changed = join(change_thread, change_result)
        join(disable_thread, disable_result)

        assert changed.status_code == 200, changed.text
        with Session(owner) as db:
            disabled = db.get(User, local_user_id)
            assert disabled is not None
            assert disabled.status == UserStatus.DISABLED.value
        # The change committed first: the provider holds the new password.
        tokens = real.password_grant(email, new_password)
        real.sign_out(tokens.access_token, scope="local")
    finally:
        browser.close()
