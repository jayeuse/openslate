"""Recover a persisted split invitation without creating a second provider identity."""

from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.integrations.supabase_auth import get_supabase_auth_client
from app.main import create_app
from app.systems.access.users.models import Membership, User
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.auth.test_provider_email_integration import _email_action
from tests.conftest import create_member, membership_of

pytest_plugins = ("tests.auth.test_provider_email_integration",)
pytestmark = pytest.mark.integration


def test_reconcile_binds_existing_marked_provider_user_and_delivers_invitation(
    provider_account,
    provider_mail,
):
    # Persist the exact split state a lost application commit leaves behind.
    # Failures to catch: duplicate provider user, wrong binding, or no usable mail.
    email, password, admin_provider_id, admin_id, owner = provider_account
    settings = get_settings()
    recipient_email = f"reconcile-{uuid4().hex}@example.test"
    operation_id = uuid4()
    local_id = None
    remote_id = None
    provider = get_supabase_auth_client()
    browser = TestClient(create_app(), base_url=settings.public_origin)
    browser.headers["Origin"] = settings.public_origin
    try:
        with Session(owner) as db:
            admin = db.get(User, admin_id)
            assert admin is not None
            admin.supabase_user_id = admin_provider_id
            membership = membership_of(db, admin.id)
            membership.role = "admin"
            pending, _pending_membership = create_member(
                db, db.get(WorkspaceProfile, membership.org_id),
                email=recipient_email,
                username=f"reconcile-{uuid4().hex[:16]}",
                status="pending",
                role="member",
                provider_invitation_operation_id=operation_id,
            )
            db.commit()
            local_id = pending.id
        remote = provider.admin_create_invitation_user(recipient_email, local_id, operation_id)
        remote_id = remote.id
        with Session(owner) as db:
            pending = db.get(User, local_id)
            assert pending is not None and pending.supabase_user_id is None
            membership = db.scalar(select(Membership).where(Membership.user_id == local_id))
            assert membership.invitation_sent_at is None

        login = browser.post("/api/auth/login", json={"email": email, "password": password})
        assert login.status_code == 200
        csrf = browser.cookies.get("openslate_csrf")
        assert csrf is not None
        repaired = browser.post(
            f"/api/auth/invitations/{local_id}/reconcile", headers={"X-CSRF-Token": csrf}
        )
        assert repaired.status_code == 200, "Administrator must recover the split invitation"
        with Session(owner) as db:
            profiles = db.scalars(select(User).where(User.email == recipient_email)).all()
            assert len(profiles) == 1
            profile = profiles[0]
            assert profile.id == local_id and profile.supabase_user_id == remote_id
            membership = db.scalar(select(Membership).where(Membership.user_id == local_id))
            assert profile.status == "pending" and membership.invitation_accepted_at is None
            assert membership.invitation_sent_at is not None
            assert membership.provider_invitation_operation_id == operation_id
        with httpx.Client(timeout=10) as admin_http:
            response = admin_http.get(
                settings.supabase_url.rstrip("/") + "/auth/v1/admin/users",
                params={"filter": recipient_email},
                headers={"apikey": settings.supabase_secret_key.get_secret_value()},
            )
            assert response.status_code == 200
            matching = [
                item["id"]
                for item in response.json()["users"]
                if item.get("email") == recipient_email
            ]
            assert matching == [str(remote_id)], "Reconciliation must retain one provider identity"
        delivered = _email_action(provider_mail, recipient_email, "invite")
        assert bool(delivered), "The owned mail sink must receive the recovered invitation"
    finally:
        browser.close()
        if remote_id is not None:
            provider.admin_delete_user(remote_id)
        if local_id is not None:
            with Session(owner) as db:
                pending = db.get(User, local_id)
                if pending is not None:
                    db.delete(db.scalar(select(Membership).where(Membership.user_id == local_id)))
                    db.flush()
                    db.delete(pending)
                    db.commit()
