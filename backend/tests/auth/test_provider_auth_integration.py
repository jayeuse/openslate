"""Real Supabase Auth and runtime-role HTTP journeys on the disposable stack."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock, patch
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import inspect, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.common.dependencies.auth as auth_dependencies
import app.systems.access.auth.router as auth_router
from app.core.config import get_settings
from app.core.database.session import AuditSession
from app.core.integrations.supabase_auth import SupabaseAuthUnavailable, get_supabase_auth_client
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.provider_user_cache import forget_provider_user
from app.systems.access.users.membership import sole_active_membership
from app.systems.access.users.models import Membership, User
from app.systems.manage.audit.models import AuditLog, SecurityEvent
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.conftest import create_member, create_organization

pytest_plugins = ("tests.auth.provider_account_support",)
pytestmark = pytest.mark.integration
DEFAULT_APPEARANCE = {
    "motion": "system",
    "keyboard_shortcuts": True,
    "timezone": None,
    "date_format": "organization",
    "time_format": "organization",
    "week_start": "organization",
    "start_page": "automatic",
}


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
        assert client.get("/api/access/groups").status_code == 403
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


@pytest.mark.parametrize("role", ["admin", "member", "guest"])
def test_self_theme_preferences_persist_audited_changes_without_account_side_effects(
    provider_account, role: str
) -> None:
    email, password, provider_id, local_id, owner = provider_account
    settings = get_settings()
    with Session(owner) as db:
        membership = sole_active_membership(db, local_id)
        organization = db.get(WorkspaceProfile, membership.org_id)
        other, _other_membership = create_member(db, organization,
            email=f"theme-other-{uuid4().hex}@example.test",
            username=f"theme-other-{uuid4().hex[:16]}",
            status="active",
            role="member",
        )
        other_id = other.id
        user = db.get(User, local_id)
        assert user is not None
        user.supabase_user_id = provider_id
        membership.role = role
        membership.sponsor_user_id = other_id if role == "guest" else None
        membership.expires_at = datetime.now(UTC) + timedelta(days=30) if role == "guest" else None
        db.commit()
    client = TestClient(create_app(), base_url=settings.public_origin)
    client.headers["Origin"] = settings.public_origin
    path = f"/api/users/{local_id}/preferences"
    audit_query = select(AuditLog).where(
        AuditLog.entity_type == "users",
        AuditLog.entity_id == local_id,
        AuditLog.action == "update",
    )
    try:
        # No identity override: real Auth, JWT, local session, role and CSRF checks.
        anonymous_read = client.get(path)
        anonymous_write = client.patch(path, json={"theme": "dark"})
        assert (
            client.post("/api/auth/login", json={"email": email, "password": password}).status_code
            == 200
        )
        initial = client.get(path)
        assert initial.status_code == 200
        assert anonymous_read.status_code == 401
        assert anonymous_write.status_code == 401
        assert initial.json() == {
            "user_id": str(local_id),
            "theme": "system",
            "appearance": DEFAULT_APPEARANCE,
        }
        assert "no-store" in initial.headers["Cache-Control"]
        assert client.patch(path, json={"theme": "dark"}).status_code == 401
        csrf = client.cookies.get("openslate_csrf")
        assert csrf is not None
        client.headers["X-CSRF-Token"] = csrf
        for target in (other_id, uuid7()):
            for response in (
                client.get(f"/api/users/{target}/preferences"),
                client.patch(f"/api/users/{target}/preferences", json={"theme": "dark"}),
            ):
                assert response.status_code == 403
                assert response.json()["detail"]["code"] == "preferences_owner_mismatch"
        with Session(owner) as db:
            before_user = db.get(User, local_id)
            assert before_user is not None
            # Only safe profile values; credential/token fields are never asserted or logged.
            account = (
                sole_active_membership(db, before_user.id).role,
                before_user.status,
                before_user.email,
                before_user.tokens_valid_after,
            )
            sessions = list(
                db.execute(
                    select(IdentitySession.id, IdentitySession.revoked_at).where(
                        IdentitySession.user_id == local_id
                    )
                )
            )
            security_ids = set(db.scalars(select(SecurityEvent.id)))
        saved = client.patch(path, json={"theme": "dark"})
        assert saved.status_code == 200
        assert saved.json() == {
            "user_id": str(local_id),
            "theme": "dark",
            "appearance": DEFAULT_APPEARANCE,
        }
        assert "no-store" in saved.headers["Cache-Control"]
        assert client.get(path).json() == saved.json()
        assert "theme_preference" not in client.get("/api/auth/me").json()
        with Session(owner) as db:
            user = db.get(User, local_id)
            other = db.get(User, other_id)
            assert user is not None and other is not None
            assert user.theme_preference == "dark"
            assert other.theme_preference == "system"
            assert (
                sole_active_membership(db, user.id).role,
                user.status, user.email, user.tokens_valid_after,
            ) == account
            assert (
                list(
                    db.execute(
                        select(IdentitySession.id, IdentitySession.revoked_at).where(
                            IdentitySession.user_id == local_id
                        )
                    )
                )
                == sessions
            )
            assert set(db.scalars(select(SecurityEvent.id))) == security_ids
            changes = list(db.scalars(audit_query))
            assert [(row.before, row.after, row.performed_by) for row in changes] == [
                ({"theme_preference": "system"}, {"theme_preference": "dark"}, local_id)
            ]
            audit_ids = {row.id for row in changes}
            updated_at = user.updated_at
        assert client.patch(path, json={"theme": "dark"}).status_code == 200
        with Session(owner) as db:
            user = db.get(User, local_id)
            assert user is not None and user.updated_at == updated_at
            assert {row.id for row in db.scalars(audit_query)} == audit_ids

        def fail_commit(db: Session) -> None:
            db.flush()
            raise SQLAlchemyError("owned theme persistence failure")

        with patch.object(AuditSession, "commit", fail_commit):
            assert client.patch(path, json={"theme": "light"}).status_code == 503
        with Session(owner) as db:
            user = db.get(User, local_id)
            assert user is not None and user.theme_preference == "dark"
            assert {row.id for row in db.scalars(audit_query)} == audit_ids
        assert client.get(path).json() == {
            "user_id": str(local_id),
            "theme": "dark",
            "appearance": DEFAULT_APPEARANCE,
        }

    finally:
        client.close()
        with Session(owner) as db:
            user = db.get(User, local_id)
            if user is not None:
                membership = sole_active_membership(db, user.id)
                membership.role, membership.sponsor_user_id, membership.expires_at = (
                    "member", None, None,
                )
                db.flush()
            other = db.get(User, other_id)
            if other is not None:
                db.delete(db.scalar(select(Membership).where(Membership.user_id == other_id)))
                db.flush()
                db.delete(other)
            db.commit()


def test_user_theme_storage_has_a_system_default_and_rejects_invalid_values(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    user, _membership = create_member(db, create_organization(db),
        email=f"theme-default-{uuid4().hex}@example.test",
        username=f"theme-{uuid4().hex[:16]}",
        role="member",
        status="active",
    )
    db.commit()
    assert (
        db.connection().scalar(
            text("SELECT theme_preference FROM users WHERE id = :id"), {"id": user.id}
        )
        == "system"
    )
    column = next(
        item
        for item in inspect(db.get_bind()).get_columns("users")
        if item["name"] == "theme_preference"
    )
    assert column["nullable"] is False
    assert "system" in column["default"]
    for invalid in (None, "sepia"):
        with pytest.raises(IntegrityError), db.begin_nested():
            db.connection().execute(
                text("UPDATE users SET theme_preference = :theme WHERE id = :id"),
                {"theme": invalid, "id": user.id},
            )
    assert (
        db.connection().scalar(
            text("SELECT theme_preference FROM users WHERE id = :id"), {"id": user.id}
        )
        == "system"
    )


def test_own_session_inventory_returns_active_sessions_newest_first_with_user_agents(
    provider_account,
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
    client.headers["User-Agent"] = "OpenSlate test browser/1.0"
    try:
        login = client.post("/api/auth/login", json={"email": email, "password": password})
        assert login.status_code == 200
        initial = client.get("/api/auth/sessions")
        assert initial.status_code == 200
        current_rows = [item for item in initial.json() if item["current"]]
        assert len(current_rows) == 1
        current_id = UUID(current_rows[0]["id"])

        now = datetime.now(UTC)
        with Session(owner) as db:
            current = db.get(IdentitySession, current_id)
            assert current is not None
            current.refreshed_at = now - timedelta(minutes=5)

            newest = IdentitySession(
                user_id=local_id,
                refresh_token_digest=uuid7().hex * 2,
                csrf_token_digest=uuid7().hex * 2,
                refreshed_at=now - timedelta(minutes=1),
                expires_at=now + timedelta(days=1),
                user_agent="Newest active browser/2.0",
            )
            oldest = IdentitySession(
                user_id=local_id,
                refresh_token_digest=uuid7().hex * 2,
                csrf_token_digest=uuid7().hex * 2,
                refreshed_at=now - timedelta(minutes=10),
                expires_at=now + timedelta(days=1),
                user_agent="Old active browser/3.0",
            )
            expired = IdentitySession(
                user_id=local_id,
                refresh_token_digest=uuid7().hex * 2,
                csrf_token_digest=uuid7().hex * 2,
                refreshed_at=now + timedelta(minutes=1),
                expires_at=now - timedelta(seconds=1),
                user_agent="Expired browser/4.0",
            )
            db.add_all([newest, oldest, expired])
            db.flush()
            newest_id = newest.id
            oldest_id = oldest.id
            expected_ids = [newest.id, current_id, oldest.id]
            expired_id = expired.id
            db.commit()

        response = client.get("/api/auth/sessions")
        assert response.status_code == 200
        sessions = response.json()
        assert [UUID(item["id"]) for item in sessions] == expected_ids
        assert expired_id not in {UUID(item["id"]) for item in sessions}
        assert {item["id"]: item["user_agent"] for item in sessions} == {
            str(newest_id): "Newest active browser/2.0",
            str(current_id): "OpenSlate test browser/1.0",
            str(oldest_id): "Old active browser/3.0",
        }

        openapi = create_app().openapi()
        response_schema = openapi["paths"]["/api/auth/sessions"]["get"]["responses"]["200"]
        item_schema = response_schema["content"]["application/json"]["schema"]["items"]
        assert "$ref" in item_schema
        component = item_schema["$ref"].rsplit("/", maxsplit=1)[-1]
        assert "user_agent" in openapi["components"]["schemas"][component]["properties"]
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

        # The outage starts after the 10 s provider-account reuse window.
        forget_provider_user(provider_id)
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
