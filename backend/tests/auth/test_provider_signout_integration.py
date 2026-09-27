"""Revocation stays immediate while the real worker removes the exact Auth session."""

from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database.session import get_engine
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.provider_signout_worker import ProviderSignoutWorker
from app.systems.access.users.models import User

pytest_plugins = ("tests.auth.test_provider_auth_integration",)
pytestmark = pytest.mark.integration


def test_signout_worker_removes_revoked_provider_session_and_preserves_other_session(
    provider_account,
):
    # Failure inventory: delayed local denial, lost durable work, wrong provider
    # session deleted, or global logout accidentally invalidating the survivor.
    email, password, provider_id, local_id, owner = provider_account
    settings = get_settings()
    with Session(owner) as db:
        user = db.get(User, local_id)
        assert user is not None
        user.supabase_user_id = provider_id
        db.commit()

    current = TestClient(create_app(), base_url=settings.public_origin)
    revoked = TestClient(create_app(), base_url=settings.public_origin)
    try:
        for browser in (current, revoked):
            browser.headers["Origin"] = settings.public_origin
            response = browser.post("/api/auth/login", json={"email": email, "password": password})
            assert response.status_code == 200, "Both independent browser logins must succeed"
        inventory = revoked.get("/api/auth/sessions")
        assert inventory.status_code == 200
        target_id = next(UUID(item["id"]) for item in inventory.json() if item["current"])
        with Session(owner) as db:
            target = db.get(IdentitySession, target_id)
            assert target is not None and target.provider_session_id is not None
            provider_session_id = target.provider_session_id

        csrf = current.cookies.get("openslate_csrf")
        assert csrf is not None, "The active browser must have CSRF protection"
        response = current.delete(f"/api/auth/sessions/{target_id}", headers={"X-CSRF-Token": csrf})
        assert response.status_code == 204
        assert revoked.get("/api/auth/me").status_code == 401
        assert current.get("/api/auth/me").status_code == 200
        with Session(owner) as db:
            target = db.get(IdentitySession, target_id)
            assert target is not None and target.revoked_at is not None
            assert target.provider_signout_pending_at is not None
            assert target.provider_signout_completed_at is None
        with Session(get_engine()) as db:
            assert (
                db.scalar(
                    text("SELECT id FROM auth.sessions WHERE id = :id AND user_id = :user_id"),
                    {"id": provider_session_id, "user_id": provider_id},
                )
                is not None
            ), "Local revocation must persist work before provider cleanup"

        ProviderSignoutWorker(settings).run_once()

        with Session(owner) as db:
            target = db.get(IdentitySession, target_id)
            assert target is not None and target.revoked_at is not None
            assert target.provider_signout_pending_at is None
            assert target.provider_signout_completed_at is not None
        with Session(get_engine()) as db:
            assert (
                db.scalar(
                    text("SELECT id FROM auth.sessions WHERE id = :id AND user_id = :user_id"),
                    {"id": provider_session_id, "user_id": provider_id},
                )
                is None
            ), "The worker must remove the exact revoked Supabase session"
        assert revoked.get("/api/auth/me").status_code == 401
        assert current.get("/api/auth/me").status_code == 200
        refreshed = current.post("/api/auth/refresh", headers={"X-CSRF-Token": csrf})
        assert refreshed.status_code == 200, "A different provider session must survive cleanup"
        assert current.get("/api/auth/me").status_code == 200
    finally:
        current.close()
        revoked.close()
