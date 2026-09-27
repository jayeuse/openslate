"""Real Supabase Auth and runtime-role HTTP journeys on the disposable stack."""

import os
from secrets import token_urlsafe
from unittest.mock import Mock
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

import app.common.dependencies.auth as auth_dependencies
import app.systems.access.auth.router as auth_router
from app.core.config import get_settings
from app.core.config.provider_instance import assert_provider_instance
from app.core.integrations.supabase_auth import SupabaseAuthUnavailable, get_supabase_auth_client
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import Role, User, UserStatus
from tests.conftest import guarded_create_engine

pytestmark = pytest.mark.integration


@pytest.fixture
def provider_account():
    settings = get_settings()
    assert_provider_instance(
        dict(os.environ), database_url=settings.database_url, expected_user="openslate_runtime"
    )
    email = f"auth-journey-{uuid4().hex}@example.test"
    password = token_urlsafe(32)
    provider_id = None
    local_id = None
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    with httpx.Client(
        base_url=settings.supabase_url.rstrip("/") + "/auth/v1/",
        headers={"apikey": settings.supabase_secret_key.get_secret_value()},
        timeout=15,
    ) as admin:
        try:
            created = admin.post(
                "admin/users", json={"email": email, "password": password, "email_confirm": True}
            )
            assert created.status_code in {200, 201}
            provider_id = UUID(created.json()["id"])
            with Session(owner) as db:
                role = db.scalar(select(Role).where(Role.role == "member"))
                assert role is not None
                user = User(
                    email=email,
                    username=f"journey-{uuid4().hex[:16]}",
                    status=UserStatus.ACTIVE.value,
                    role_id=role.id,
                    # Deliberately unbound first: matching email cannot grant access.
                )
                db.add(user)
                db.commit()
                local_id = user.id
            yield email, password, provider_id, local_id, owner
        finally:
            if provider_id is not None:
                deleted = admin.delete(f"admin/users/{provider_id}")
                assert deleted.status_code in {200, 204, 404}
            if local_id is not None:
                with Session(owner) as db:
                    for session in db.scalars(
                        select(IdentitySession).where(IdentitySession.user_id == local_id)
                    ):
                        db.delete(session)
                    user = db.get(User, local_id)
                    if user is not None:
                        db.delete(user)
                    db.commit()
            owner.dispose()


def test_browser_session_requires_binding_and_supports_refresh_csrf_and_revocation(
    provider_account,
):
    email, password, provider_id, local_id, owner = provider_account
    settings = get_settings()
    # The real app middleware, routes, dependencies, runtime DB role and provider
    # client run here. Background workers are outside this synchronous HTTP journey.
    client = TestClient(create_app(), base_url=settings.public_origin)
    client.headers["Origin"] = settings.public_origin
    try:
        assert (
            client.post("/api/auth/login", json={"email": email, "password": password}).status_code
            == 401
        )
        with Session(owner) as db:
            user = db.get(User, local_id)
            assert user is not None
            assert user.supabase_user_id is None
            user.supabase_user_id = provider_id
            db.commit()
        login = client.post("/api/auth/login", json={"email": email, "password": password})
        assert login.status_code == 200
        assert login.json() == {"authenticated": True, "setup_required": False}
        assert client.get("/api/auth/me").status_code == 200
        assert client.get("/api/roles").status_code == 403
        csrf = client.cookies.get("openslate_csrf")
        assert csrf
        cookie_headers = login.headers.get_list("set-cookie")
        assert any(
            "openslate_access=" in value and "HttpOnly" in value and "Secure" in value
            for value in cookie_headers
        )
        # Cookie mutations require the independently held CSRF value.
        assert client.post("/api/auth/refresh").status_code == 401
        client.headers["X-CSRF-Token"] = csrf
        assert client.post("/api/auth/refresh").status_code == 200
        sessions = client.get("/api/auth/sessions")
        assert sessions.status_code == 200
        active = [item for item in sessions.json() if item["current"]]
        assert len(active) == 1
        stale_cookie = client.cookies.get("openslate_access")
        revoked = client.delete(f"/api/auth/sessions/{active[0]['id']}")
        assert revoked.status_code == 204
        # An already issued provider JWT cannot bypass backend revocation.
        client.cookies.clear()
        client.headers.pop("X-CSRF-Token")
        client.headers["Authorization"] = f"Bearer {stale_cookie}"
        assert client.get("/api/auth/me").status_code == 401
        with Session(owner) as db:
            session = db.get(IdentitySession, UUID(active[0]["id"]))
            assert session is not None and session.revoked_at is not None
            assert session.provider_signout_pending_at is not None
    finally:
        client.close()


def test_browser_logout_revokes_local_session_during_provider_outage(
    provider_account, monkeypatch: pytest.MonkeyPatch
) -> None:
    email, password, provider_id, local_id, owner = provider_account
    with Session(owner) as db:
        user = db.get(User, local_id)
        assert user is not None
        user.supabase_user_id = provider_id
        db.commit()

    settings = get_settings()
    client = TestClient(create_app(), base_url=settings.public_origin)
    client.headers["Origin"] = settings.public_origin
    try:
        login = client.post("/api/auth/login", json={"email": email, "password": password})
        assert login.status_code == 200
        csrf = client.cookies.get("openslate_csrf")
        access = client.cookies.get("openslate_access")
        assert csrf and access
        client.headers["X-CSRF-Token"] = csrf
        active = client.get("/api/auth/sessions")
        assert active.status_code == 200
        session_id = UUID(next(row["id"] for row in active.json() if row["current"]))

        offline = Mock(wraps=get_supabase_auth_client())
        offline.get_admin_user.side_effect = SupabaseAuthUnavailable("offline")
        offline.refresh.side_effect = SupabaseAuthUnavailable("offline")
        with monkeypatch.context() as outage:
            outage.setattr(auth_dependencies, "get_supabase_auth_client", lambda: offline)
            outage.setattr(auth_router, "get_supabase_auth_client", lambda: offline)
            assert client.get("/api/auth/me").status_code == 503
            logged_out = client.post("/api/auth/logout")

        assert logged_out.status_code == 204
        assert any(
            'openslate_access=""' in header for header in logged_out.headers.get_list("set-cookie")
        )
        assert any(
            'openslate_refresh=""' in header for header in logged_out.headers.get_list("set-cookie")
        )
        with Session(owner) as db:
            session = db.get(IdentitySession, session_id)
            assert session is not None
            assert session.revoked_at is not None
            assert session.provider_signout_pending_at is not None
            assert session.provider_signout_next_attempt_at is not None
        client.cookies.clear()
        client.headers.pop("X-CSRF-Token")
        client.headers["Authorization"] = f"Bearer {access}"
        assert client.get("/api/auth/me").status_code == 401
    finally:
        client.close()
