"""Administrator-managed application session route contracts."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import CurrentIdentity, get_current_identity
from app.common.listing import ListQueryResult, PaginationMetadata
from app.core.database import get_db
from app.systems.access.auth.aggregate_router import router
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.session_revocation import revoke_session, revoke_user_sessions
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.manage.workspace.models import PlatformSettings, WorkspaceProfile
from tests.organization_scope_support import scoped_override
from tests.users.user_support import local_user


@pytest.fixture(autouse=True)
def neutral_session_policy(monkeypatch):
    from app.systems.access.users import sessions_router

    monkeypatch.setattr(
        sessions_router,
        "load_platform_policy",
        lambda _db: PlatformSettings(
            session_timeout_minutes=60, session_absolute_lifetime_minutes=None
        ),
    )


def _admin_identity() -> tuple[User, CurrentIdentity]:
    admin_id = uuid7()
    current_session_id = uuid7()
    admin, _membership = local_user(UserRole.ADMIN)
    admin.id = admin_id
    return admin, CurrentIdentity(admin, current_session_id, False, False)


def _application(db: Session, identity: CurrentIdentity):
    application = FastAPI()
    application.include_router(router, prefix="/api")
    application.dependency_overrides[get_db] = lambda: db
    application.dependency_overrides[get_current_identity] = scoped_override(lambda: identity)
    return application


def _target_user(user_id) -> User:
    return User(
        id=user_id,
        email="target@example.test",
        username="target",
        status=UserStatus.ACTIVE.value,
    )


def _session(user_id, *, refreshed_at: datetime, user_agent: str | None = None) -> IdentitySession:
    return IdentitySession(
        id=uuid7(),
        user_id=user_id,
        refresh_token_digest="r" * 64,
        csrf_token_digest="c" * 64,
        created_at=refreshed_at - timedelta(hours=1),
        refreshed_at=refreshed_at,
        expires_at=refreshed_at + timedelta(days=7),
        user_agent=user_agent,
    )


def test_admin_lists_active_sessions_in_stable_descending_order_without_secret_digests(
    monkeypatch,
) -> None:
    from app.systems.access.users import sessions_router

    admin, identity = _admin_identity()
    target_id = uuid7()
    timestamp = datetime.now(UTC)
    session = _session(target_id, refreshed_at=timestamp, user_agent="Browser/1.0")
    db = Mock(spec=Session)
    captured: dict[str, object] = {}

    def list_sessions(database, statement, params, spec):
        captured.update(
            {"database": database, "statement": statement, "params": params, "spec": spec}
        )
        return ListQueryResult(
            items=[session],
            pagination=PaginationMetadata(limit=1, offset=0, count=1, total=1, has_more=False),
        )

    monkeypatch.setattr(sessions_router, "require_fresh_exact_admin", lambda *_args: admin)
    monkeypatch.setattr(sessions_router, "execute_standard_list", list_sessions)
    monkeypatch.setattr(sessions_router, "load_user", lambda *_args: _target_user(target_id))
    monkeypatch.setattr(sessions_router, "utc_now", lambda: timestamp)
    application = _application(db, identity)

    with TestClient(application, raise_server_exceptions=False) as client:
        response = client.get(f"/api/users/{target_id}/sessions?limit=1&offset=0")

    assert response.status_code == 200
    body = response.json()
    assert body["items"] == [
        {
            "id": str(session.id),
            "created_at": session.created_at.isoformat().replace("+00:00", "Z"),
            "refreshed_at": session.refreshed_at.isoformat().replace("+00:00", "Z"),
            "expires_at": (session.refreshed_at + timedelta(minutes=60))
            .isoformat()
            .replace("+00:00", "Z"),
            "user_agent": "Browser/1.0",
            "ip_address": None,
            "current": False,
        }
    ]
    assert "refresh_token_digest" not in body["items"][0]
    assert "csrf_token_digest" not in body["items"][0]
    assert captured["database"] is db
    assert captured["params"].sort_order.value == "desc"
    assert captured["spec"].default_sort.value == "refreshed_at"
    compiled = captured["statement"].compile()
    assert "identity_sessions.expires_at >" in str(compiled)
    assert timestamp in compiled.params.values()
    application.dependency_overrides.clear()


def test_admin_session_list_returns_not_found_for_a_missing_user(monkeypatch) -> None:
    from app.systems.access.users import sessions_router

    admin, identity = _admin_identity()
    missing_id = uuid7()
    db = Mock(spec=Session)
    db.scalar.return_value = None
    monkeypatch.setattr(sessions_router, "require_fresh_exact_admin", lambda *_args: admin)
    application = _application(db, identity)

    with TestClient(application, raise_server_exceptions=False) as client:
        response = client.get(f"/api/users/{missing_id}/sessions")

    assert response.status_code == 404
    application.dependency_overrides.clear()


def test_admin_cannot_revoke_own_current_session(monkeypatch) -> None:
    from app.systems.access.users import sessions_router

    admin, identity = _admin_identity()
    db = Mock(spec=Session)
    record_event = Mock()
    revoke = Mock(return_value=True)
    monkeypatch.setattr(sessions_router, "require_fresh_exact_admin", lambda *_args: admin)
    monkeypatch.setattr(sessions_router, "append_security_event", record_event)
    monkeypatch.setattr(sessions_router, "revoke_session", revoke)
    monkeypatch.setattr(sessions_router, "load_user", lambda *_args: _target_user(admin.id))
    application = _application(db, identity)

    with TestClient(application, raise_server_exceptions=False) as client:
        response = client.delete(f"/api/users/{admin.id}/sessions/{identity.session_id}")

    assert response.status_code == 409
    revoke.assert_not_called()
    record_event.assert_not_called()
    db.commit.assert_not_called()
    application.dependency_overrides.clear()


def test_admin_revocation_is_idempotent_and_records_a_redacted_security_event(monkeypatch) -> None:
    from app.systems.access.users import sessions_router

    admin, identity = _admin_identity()
    target_id = uuid7()
    target_session_id = uuid7()
    db = Mock(spec=Session)
    record_event = Mock()
    revoke = Mock(side_effect=[True, False])
    monkeypatch.setattr(sessions_router, "require_fresh_exact_admin", lambda *_args: admin)
    monkeypatch.setattr(sessions_router, "append_security_event", record_event)
    monkeypatch.setattr(sessions_router, "revoke_session", revoke)
    monkeypatch.setattr(sessions_router, "load_user", lambda *_args: _target_user(target_id))
    application = _application(db, identity)

    with TestClient(application, raise_server_exceptions=False) as client:
        first = client.delete(f"/api/users/{target_id}/sessions/{target_session_id}")
        second = client.delete(f"/api/users/{target_id}/sessions/{target_session_id}")

    assert first.status_code == 204 and second.status_code == 204
    assert revoke.call_count == 2
    revoke.assert_called_with(db, target_session_id, target_id)
    db.commit.assert_called_once()
    event = record_event.call_args.args[1]
    assert event.event_type == "identity.session_revocation"
    assert event.actor_id == admin.id
    assert event.subject_id == target_id
    assert event.labels == {"scope": "one"}
    assert event.metadata == {}
    application.dependency_overrides.clear()


def test_admin_collection_revocation_keeps_its_own_current_session(monkeypatch) -> None:
    from app.systems.access.users import sessions_router

    admin, identity = _admin_identity()
    db = Mock(spec=Session)
    monkeypatch.setattr(sessions_router, "require_fresh_exact_admin", lambda *_args: admin)
    monkeypatch.setattr(sessions_router, "append_security_event", Mock())
    monkeypatch.setattr(sessions_router, "revoke_user_sessions", Mock(return_value=1))
    record_event = Mock()
    monkeypatch.setattr(sessions_router, "append_security_event", record_event)
    monkeypatch.setattr(sessions_router, "load_user", lambda *_args: _target_user(admin.id))
    application = _application(db, identity)

    with TestClient(application, raise_server_exceptions=False) as client:
        response = client.delete(f"/api/users/{admin.id}/sessions")

    assert response.status_code == 204
    event = record_event.call_args.args[1]
    assert event.labels == {"scope": "others"}
    db.commit.assert_called_once()
    application.dependency_overrides.clear()


def test_admin_collection_revocation_is_a_noop_without_audit_event(monkeypatch) -> None:
    from app.systems.access.users import sessions_router

    admin, identity = _admin_identity()
    target_id = uuid7()
    db = Mock(spec=Session)
    record_event = Mock()
    monkeypatch.setattr(sessions_router, "require_fresh_exact_admin", lambda *_args: admin)
    monkeypatch.setattr(sessions_router, "revoke_user_sessions", Mock(return_value=0))
    monkeypatch.setattr(sessions_router, "append_security_event", record_event)
    monkeypatch.setattr(sessions_router, "load_user", lambda *_args: _target_user(target_id))
    application = _application(db, identity)

    with TestClient(application, raise_server_exceptions=False) as client:
        response = client.delete(f"/api/users/{target_id}/sessions")

    assert response.status_code == 204
    record_event.assert_not_called()
    db.commit.assert_not_called()
    application.dependency_overrides.clear()


def test_admin_session_revocation_rolls_back_when_the_commit_fails(monkeypatch) -> None:
    from app.systems.access.users import sessions_router

    admin, identity = _admin_identity()
    target_id = uuid7()
    db = Mock(spec=Session)
    db.commit.side_effect = SQLAlchemyError("unavailable")
    monkeypatch.setattr(sessions_router, "require_fresh_exact_admin", lambda *_args: admin)
    monkeypatch.setattr(sessions_router, "revoke_session", Mock(return_value=True))
    monkeypatch.setattr(sessions_router, "append_security_event", Mock())
    monkeypatch.setattr(sessions_router, "load_user", lambda *_args: _target_user(target_id))
    application = _application(db, identity)

    with TestClient(application, raise_server_exceptions=False) as client:
        response = client.delete(f"/api/users/{target_id}/sessions/{uuid7()}")

    assert response.status_code == 503
    db.rollback.assert_called_once()
    application.dependency_overrides.clear()


def test_revoke_session_keeps_an_existing_revocation_timestamp() -> None:
    user_id = uuid7()
    prior_revocation = datetime.now(UTC) - timedelta(minutes=1)
    session = _session(user_id, refreshed_at=datetime.now(UTC))
    session.revoked_at = prior_revocation
    db = Mock(spec=Session)
    db.get.return_value = session

    assert not revoke_session(db, session.id, user_id, now=datetime.now(UTC))
    assert session.revoked_at == prior_revocation


def test_revoke_user_sessions_returns_only_the_number_of_newly_changed_sessions() -> None:
    user_id = uuid7()
    timestamp = datetime.now(UTC)
    active = _session(user_id, refreshed_at=timestamp)
    revoked = _session(user_id, refreshed_at=timestamp)
    revoked.revoked_at = timestamp - timedelta(minutes=1)
    preserved = _session(user_id, refreshed_at=timestamp)
    db = Mock(spec=Session)
    db.scalars.return_value = [active, revoked, preserved]

    changed = revoke_user_sessions(db, user_id, except_session_id=preserved.id, now=timestamp)

    assert changed == 1
    assert active.revoked_at == timestamp
    assert revoked.revoked_at == timestamp - timedelta(minutes=1)
    assert preserved.revoked_at is None


@pytest.mark.parametrize("stale_admin", (False, True))
def test_session_routes_reject_non_admin_and_cookie_mutation_without_csrf(
    monkeypatch, stale_admin: bool
) -> None:
    from app.common.dependencies import auth as auth_dependencies
    from app.systems.access.users import sessions_router

    admin, identity = _admin_identity()
    target_id = uuid7()
    member = _target_user(admin.id)
    db = Mock(spec=Session)
    db.scalar.return_value = member
    db.dirty = set()
    db.scalars.return_value.all.return_value = [Membership(
        user_id=member.id, role="member", status="active", is_deleted=False,
    )]
    cached_actor = admin if stale_admin else member
    application = _application(db, CurrentIdentity(cached_actor, identity.session_id, False, False))

    with TestClient(application, raise_server_exceptions=False) as client:
        denied = client.get(f"/api/users/{target_id}/sessions")
        collection_denied = client.get("/api/auth/admin-sessions")
        bulk_denied = client.delete("/api/auth/admin-sessions")

    assert denied.status_code == 403
    assert collection_denied.status_code == 403
    assert bulk_denied.status_code == 403
    db.commit.assert_not_called()
    application.dependency_overrides.clear()

    session = _session(admin.id, refreshed_at=datetime.now(UTC))
    db = Mock(spec=Session)
    db.get.return_value = session
    db.info = {}
    monkeypatch.setattr(
        auth_dependencies,
        "get_settings",
        lambda: SimpleNamespace(public_origin="http://frontend.test"),
    )
    provider = Mock()
    monkeypatch.setattr(auth_dependencies, "get_supabase_auth_client", lambda: provider)
    monkeypatch.setattr(
        auth_dependencies, "resolve_provider_session", lambda *_args, **_kwargs: (admin, session)
    )
    monkeypatch.setattr(
        auth_dependencies,
        "load_workspace_policy",
        lambda _db: WorkspaceProfile(ip_allow_list=[]),
    )
    monkeypatch.setattr(auth_dependencies, "load_platform_policy", lambda _db: PlatformSettings(
        session_timeout_minutes=60, session_absolute_lifetime_minutes=None,
    ))
    monkeypatch.setattr(sessions_router, "require_fresh_exact_admin", lambda *_args: admin)
    monkeypatch.setattr(sessions_router, "load_user", lambda *_args: _target_user(target_id))
    application = FastAPI()
    application.include_router(router, prefix="/api")
    application.dependency_overrides[get_db] = lambda: db

    with TestClient(application, raise_server_exceptions=False) as client:
        csrf_denied = client.delete(
            f"/api/users/{target_id}/sessions/{uuid7()}",
            headers={"Origin": "http://frontend.test"},
            cookies={"openslate_access": "access-token"},
        )
        bulk_csrf_denied = client.delete(
            "/api/auth/admin-sessions",
            headers={"Origin": "http://frontend.test"},
            cookies={"openslate_access": "access-token"},
        )

    assert csrf_denied.status_code == 401
    assert bulk_csrf_denied.status_code == 401
    application.dependency_overrides.clear()


@pytest.mark.parametrize(
    ("method", "path_suffix"),
    [
        ("get", ""),
        ("delete", ""),
        ("delete", "/session"),
        ("get", "admin"),
        ("delete", "admin"),
    ],
)
def test_setup_only_admin_cannot_manage_another_users_sessions(
    monkeypatch, method: str, path_suffix: str
) -> None:
    from app.systems.access.users import sessions_router

    admin, regular_identity = _admin_identity()
    identity = CurrentIdentity(admin, regular_identity.session_id, False, True)
    target_id = uuid7()
    db = Mock(spec=Session)
    fresh_admin = Mock(return_value=admin)
    load_target = Mock(return_value=_target_user(target_id))
    monkeypatch.setattr(sessions_router, "require_fresh_exact_admin", fresh_admin)
    monkeypatch.setattr(sessions_router, "load_user", load_target)
    monkeypatch.setattr(
        sessions_router,
        "execute_standard_list",
        Mock(
            return_value=ListQueryResult(
                items=[],
                pagination=PaginationMetadata(limit=20, offset=0, count=0, total=0, has_more=False),
            )
        ),
    )
    monkeypatch.setattr(sessions_router, "revoke_session", Mock(return_value=False))
    monkeypatch.setattr(sessions_router, "revoke_user_sessions", Mock(return_value=0))
    application = _application(db, identity)
    path = f"/api/users/{target_id}/sessions"
    if path_suffix == "admin":
        path = "/api/auth/admin-sessions"
    elif path_suffix:
        path += f"/{uuid7()}"

    with TestClient(application, raise_server_exceptions=False) as client:
        response = getattr(client, method)(path)

    assert response.status_code == 401
    fresh_admin.assert_not_called()
    load_target.assert_not_called()
    db.commit.assert_not_called()
    application.dependency_overrides.clear()


def test_admin_session_collection_returns_paged_public_person_and_client_metadata(
    monkeypatch,
) -> None:
    from app.systems.access.users import sessions_router

    admin, identity = _admin_identity()
    timestamp = datetime.now(UTC)
    session = _session(admin.id, refreshed_at=timestamp, user_agent="Firefox/1.0 Linux")
    identity = CurrentIdentity(admin, session.id, False, False)
    db = Mock(spec=Session)
    db.scalar.return_value = admin
    db.dirty = set()
    db.scalars.return_value.all.return_value = [Membership(
        user_id=admin.id, role="admin", status="active", is_deleted=False,
    )]
    db.execute.return_value.mappings.return_value.all.return_value = [
        {
            "session_id": session.id,
            "person_name": "Session Administrator",
            "device": "Desktop",
            "browser": "Firefox",
        }
    ]
    monkeypatch.setattr(
        sessions_router,
        "execute_standard_list",
        Mock(
            return_value=ListQueryResult(
                items=[session],
                pagination=PaginationMetadata(limit=1, offset=0, count=1, total=1, has_more=False),
            )
        ),
    )
    application = _application(db, identity)

    with TestClient(application, raise_server_exceptions=False) as client:
        response = client.get("/api/auth/admin-sessions?limit=1&offset=0")

    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item == {
        "id": str(session.id),
        "user_id": str(admin.id),
        "person_name": "Session Administrator",
        "user_agent": "Firefox/1.0 Linux",
        "ip_address": None,
        "device": "Desktop",
        "browser": "Firefox",
        "created_at": session.created_at.isoformat().replace("+00:00", "Z"),
        "refreshed_at": session.refreshed_at.isoformat().replace("+00:00", "Z"),
        "expires_at": (session.refreshed_at + timedelta(minutes=60))
        .isoformat()
        .replace("+00:00", "Z"),
        "current": True,
    }
    assert response.json()["pagination"] == {
        "limit": 1,
        "offset": 0,
        "count": 1,
        "total": 1,
        "has_more": False,
    }
    assert response.headers["cache-control"] == "no-store"
    application.dependency_overrides.clear()
