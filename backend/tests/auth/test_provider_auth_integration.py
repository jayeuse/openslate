"""Real Supabase Auth and runtime-role HTTP journeys on the disposable stack."""

import os
from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe
from unittest.mock import Mock, patch
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, inspect, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.common.dependencies.auth as auth_dependencies
import app.systems.access.auth.router as auth_router
from app.core.config import get_settings
from app.core.config.provider_instance import assert_provider_instance
from app.core.database.session import AuditSession
from app.core.integrations.supabase_auth import SupabaseAuthUnavailable, get_supabase_auth_client
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User, UserStatus
from app.systems.manage.audit.models import AuditLog, SecurityEvent
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
                user = User(
                    email=email,
                    username=f"journey-{uuid4().hex[:16]}",
                    status=UserStatus.ACTIVE.value,
                    role="member",
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
        other = User(
            email=f"theme-other-{uuid4().hex}@example.test",
            username=f"theme-other-{uuid4().hex[:16]}",
            status="active",
            role="member",
        )
        db.add(other)
        db.flush()
        other_id = other.id
        user = db.get(User, local_id)
        assert user is not None
        user.supabase_user_id = provider_id
        user.role = role
        user.sponsor_user_id = other_id if role == "guest" else None
        user.expires_at = datetime.now(UTC) + timedelta(days=30) if role == "guest" else None
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
        assert initial.json() == {"user_id": str(local_id), "theme": "light"}
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
        for invalid in (
            {},
            {"theme": None},
            {"theme": "system"},
            {"theme": "dark", "role": "admin"},
        ):
            assert client.patch(path, json=invalid).status_code == 422
        with Session(owner) as db:
            before_user = db.get(User, local_id)
            assert before_user is not None
            # Only safe profile values; credential/token fields are never asserted or logged.
            account = (
                before_user.role,
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
        assert saved.json() == {"user_id": str(local_id), "theme": "dark"}
        assert "no-store" in saved.headers["Cache-Control"]
        assert client.get(path).json() == saved.json()
        assert "theme_preference" not in client.get("/api/auth/me").json()
        with Session(owner) as db:
            user = db.get(User, local_id)
            other = db.get(User, other_id)
            assert user is not None and other is not None
            assert user.theme_preference == "dark"
            assert other.theme_preference == "light"
            assert (user.role, user.status, user.email, user.tokens_valid_after) == account
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
                ({"theme_preference": "light"}, {"theme_preference": "dark"}, local_id)
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
        assert client.get(path).json() == {"user_id": str(local_id), "theme": "dark"}

        raced = []

        def change_after_auth_read(_db: Session, instance: object) -> None:
            if isinstance(instance, User) and instance.id == local_id and not raced:
                raced.append(True)
                with Session(owner) as concurrent:
                    changed = concurrent.get(User, local_id)
                    assert changed is not None
                    changed.theme_preference = "light"
                    concurrent.commit()

        # A separate connection commits after auth loaded its User. Same-value
        # detection must use fresh locked state, not report an unpersisted theme.
        event.listen(AuditSession, "loaded_as_persistent", change_after_auth_read)
        try:
            accepted = client.patch(path, json={"theme": "dark"})
            assert raced and accepted.status_code == 200
            assert accepted.json() == {"user_id": str(local_id), "theme": "dark"}
        finally:
            event.remove(AuditSession, "loaded_as_persistent", change_after_auth_read)
        with Session(owner) as db:
            assert db.get(User, local_id).theme_preference == "dark"
            assert len(list(db.scalars(audit_query))) == 2
    finally:
        client.close()
        with Session(owner) as db:
            user = db.get(User, local_id)
            if user is not None:
                user.role, user.sponsor_user_id, user.expires_at = "member", None, None
                db.flush()
            other = db.get(User, other_id)
            if other is not None:
                db.delete(other)
            db.commit()


def test_user_theme_storage_has_a_light_default_and_rejects_invalid_values(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    user = User(
        email=f"theme-default-{uuid4().hex}@example.test",
        username=f"theme-{uuid4().hex[:16]}",
        role="member",
        status="active",
    )
    db.add(user)
    db.commit()
    assert (
        db.connection().scalar(
            text("SELECT theme_preference FROM users WHERE id = :id"), {"id": user.id}
        )
        == "light"
    )
    column = next(
        item
        for item in inspect(db.get_bind()).get_columns("users")
        if item["name"] == "theme_preference"
    )
    assert column["nullable"] is False
    assert "light" in column["default"]
    for invalid in (None, "system"):
        with pytest.raises(IntegrityError), db.begin_nested():
            db.connection().execute(
                text("UPDATE users SET theme_preference = :theme WHERE id = :id"),
                {"theme": invalid, "id": user.id},
            )
    assert (
        db.connection().scalar(
            text("SELECT theme_preference FROM users WHERE id = :id"), {"id": user.id}
        )
        == "light"
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
                refreshed_at=now - timedelta(days=1),
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
