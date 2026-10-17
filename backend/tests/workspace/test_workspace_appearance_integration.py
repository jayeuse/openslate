"""Organization appearance through the real login route (fake provider) and the runtime DB."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.main import create_app
from app.systems.access.users.models import User
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.conftest import create_member, membership_of, workspace_of

pytest_plugins = ("tests.fake_provider_support",)
pytestmark = pytest.mark.integration
_FIELDS = (
    "revision",
    "display_name",
    "contact_email",
    "contact_phone",
    "postal_address",
    "theme",
)


def _client() -> TestClient:
    return TestClient(
        create_app(), base_url=get_settings().public_origin, client=("127.0.0.1", 50000)
    )


def test_public_appearance_is_anonymous_theme_only_and_no_store(fake_provider_account):
    client = _client()
    try:
        assert client.get("/api/workspace").status_code == 401
        public = client.get("/api/workspace/appearance")
        assert public.status_code == 200
        assert public.json() == {"theme": "slate"}
        assert public.headers["Cache-Control"] == "no-store"
        assert client.patch(
            "/api/workspace/appearance", json={"theme": "stockroom"}
        ).status_code in (
            403,
            405,
        )
        assert client.get("/api/workspace/appearance").json() == {"theme": "slate"}
    finally:
        client.close()


@pytest.fixture
def appearance_workspace(fake_provider_account):
    email, password, provider_id, local_id, owner = fake_provider_account
    with Session(owner) as db:
        user = db.get(User, local_id)
        assert user is not None
        user.supabase_user_id = provider_id
        membership = membership_of(db, local_id)
        membership.role = "admin"
        profile = db.get(WorkspaceProfile, membership.org_id)
        assert profile is not None
        original = {field: getattr(profile, field) for field in _FIELDS}
        profile.theme = "slate"
        profile.contact_email = "private-appearance@example.test"
        profile.contact_phone = "Private phone"
        profile.postal_address = "Private postal address"
        db.commit()
    client = _client()
    client.headers["Origin"] = get_settings().public_origin
    try:
        assert (
            client.post("/api/auth/login", json={"email": email, "password": password}).status_code
            == 200
        )
        csrf = client.cookies.get("openslate_csrf")
        assert csrf
        client.headers["X-CSRF-Token"] = csrf
        yield client, local_id, owner
    finally:
        client.close()
        with Session(owner) as db:
            profile = workspace_of(db, local_id)
            assert profile is not None
            for field, value in original.items():
                setattr(profile, field, value)
            db.commit()


@pytest.mark.parametrize("theme", ["slate", "whiteboard", "triplicate", "stockroom"])
def test_admin_theme_save_is_audited_revision_guarded_and_public(appearance_workspace, theme):
    client, actor_id, owner = appearance_workspace
    before = client.get("/api/workspace").json()
    saved = client.patch("/api/workspace", json={"revision": before["revision"], "theme": theme})
    assert saved.status_code == 200
    after = saved.json()
    assert after["theme"] == theme
    assert after["revision"] == before["revision"] + 1
    assert client.get("/api/workspace").json() == after
    with Session(owner) as db:
        org_id = workspace_of(db, actor_id).id
    anonymous = _client()
    try:
        # The sign-in page asks for the browser's last organization (owner decision 3).
        public = anonymous.get("/api/workspace/appearance", params={"org": str(org_id)})
        assert public.status_code == 200
        assert public.json() == {"theme": theme}
        assert public.headers["Cache-Control"] == "no-store"
    finally:
        anonymous.close()
    stale = client.patch(
        "/api/workspace", json={"revision": before["revision"], "theme": "triplicate"}
    )
    assert stale.status_code == 409
    assert client.get("/api/workspace").json() == after
    with Session(owner) as db:
        profile = workspace_of(db, actor_id)
        assert profile is not None and profile.theme == theme
        audit = db.scalar(
            select(AuditLog)
            .where(AuditLog.entity_id == profile.id)
            .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        )
        assert audit is not None and audit.performed_by == actor_id
        if theme != "slate":
            assert audit.before["theme"] == "slate"
            assert audit.after["theme"] == theme
    renamed = client.patch(
        "/api/workspace", json={"revision": after["revision"], "display_name": "Appearance test"}
    )
    assert renamed.status_code == 200
    assert renamed.json()["theme"] == theme


@pytest.mark.parametrize("role", ["member", "guest"])
def test_current_admin_role_loss_cannot_save_theme(appearance_workspace, role):
    client, actor_id, owner = appearance_workspace
    before = client.get("/api/workspace").json()
    sponsor_id = None
    with Session(owner) as db:
        user = db.get(User, actor_id)
        assert user is not None
        membership = membership_of(db, actor_id)
        if role == "guest":
            sponsor, _membership = create_member(db, db.get(WorkspaceProfile,
                membership_of(db, actor_id).org_id),
                email=f"appearance-sponsor-{uuid4().hex}@example.test",
                username=f"appearance-sponsor-{uuid4().hex[:12]}",
                status="active",
                role="admin",
            )
            db.add(sponsor)
            db.flush()
            sponsor_id = sponsor.id
            membership.sponsor_user_id = sponsor_id
            membership.expires_at = datetime.now(UTC) + timedelta(days=1)
        membership.role = role
        db.commit()
    try:
        denied = client.patch(
            "/api/workspace", json={"revision": before["revision"], "theme": "stockroom"}
        )
        assert denied.status_code == 403
        unchanged = client.get("/api/workspace").json()
        assert unchanged["theme"] == before["theme"]
        assert unchanged["revision"] == before["revision"]
    finally:
        if sponsor_id is not None:
            with Session(owner) as db:
                user = db.get(User, actor_id)
                assert user is not None
                membership = membership_of(db, actor_id)
                membership.role = "admin"
                membership.sponsor_user_id = None
                membership.expires_at = None
                db.flush()
                sponsor = db.get(User, sponsor_id)
                assert sponsor is not None
                db.delete(membership_of(db, sponsor_id))
                db.flush()
                db.delete(sponsor)
                db.commit()


@pytest.mark.parametrize("failure", ["missing", "database"])
def test_public_appearance_failure_is_generic_no_store(monkeypatch, failure):
    from app.systems.manage.workspace import router

    def unavailable(_db, _org=None):
        if failure == "missing":
            raise router._workspace_unavailable()
        raise SQLAlchemyError("Sensitive database diagnostics must stay private")

    monkeypatch.setattr(router, "_signed_out_theme", unavailable)
    client = _client()
    try:
        response = client.get("/api/workspace/appearance")
        assert response.status_code == 503
        assert response.json() == {
            "detail": {
                "code": "workspace_unavailable",
                "message": "Workspace configuration is unavailable",
            }
        }
        assert response.headers["Cache-Control"] == "no-store"
    finally:
        client.close()
