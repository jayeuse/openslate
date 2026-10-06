"""Workspace security contracts through real provider auth and the runtime DB role."""

from datetime import datetime
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.audit.snapshots import REDACTED
from app.systems.manage.workspace.models import WorkspaceProfile

pytest_plugins = ("tests.auth.test_provider_auth_integration",)
pytestmark = pytest.mark.integration

_FIELDS = (
    "revision",
    "session_timeout_minutes",
    "password_min_length",
    "password_require_mixed_case",
    "password_require_number",
    "session_absolute_lifetime_minutes",
    "session_concurrent_limit",
    "mfa_require_admin",
    "mfa_require_member",
    "mfa_require_guest",
    "mfa_grace_days",
    "login_failed_attempt_threshold",
    "login_window_minutes",
    "login_cooldown_minutes",
    "ip_allow_list",
)


@pytest.fixture
def security_workspace(provider_account):
    email, password, provider_id, local_id, owner = provider_account
    with Session(owner) as db:
        user = db.get(User, local_id)
        assert user is not None
        user.supabase_user_id = provider_id
        user.role = "admin"
        profile = db.scalar(select(WorkspaceProfile))
        assert profile is not None
        original = {field: getattr(profile, field) for field in _FIELDS}
        profile.session_timeout_minutes = 60
        profile.password_min_length = 12
        profile.password_require_mixed_case = True
        profile.password_require_number = False
        profile.mfa_require_admin = profile.mfa_require_member = profile.mfa_require_guest = False
        profile.mfa_grace_days = 0
        profile.session_absolute_lifetime_minutes = profile.session_concurrent_limit = None
        profile.login_failed_attempt_threshold = 5
        profile.login_window_minutes = profile.login_cooldown_minutes = 15
        profile.ip_allow_list = []
        db.commit()
    settings = get_settings()
    app = create_app()
    client = TestClient(app, base_url=settings.public_origin, client=("127.0.0.1", 50000))
    client.headers["Origin"] = settings.public_origin
    try:
        assert client.get("/api/workspace/security").status_code == 401
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
            profile = db.scalar(select(WorkspaceProfile))
            assert profile is not None
            for field, value in original.items():
                setattr(profile, field, value)
            db.commit()


def test_workspace_security_saves_canonical_settings_with_audit_and_stale_protection(
    security_workspace,
):
    client, local_id, owner = security_workspace
    initial = client.get("/api/workspace/security")
    assert initial.status_code == 200
    before = initial.json()
    assert set(before) == set(_FIELDS)
    assert before["password_min_length"] == 12
    assert before["password_require_mixed_case"] is True
    assert before["password_require_number"] is False
    assert not any(before[f"mfa_require_{role}"] for role in ("admin", "member", "guest"))
    saved = client.patch(
        "/api/workspace/security",
        json={
            "revision": before["revision"],
            "session_timeout_minutes": 30,
            "password_min_length": 16,
            "password_require_mixed_case": True,
            "password_require_number": True,
            "ip_allow_list": ["127.0.0.9/24", "::ffff:127.0.0.1/128", "2001:db8::55/64"],
        },
    )
    assert saved.status_code == 200
    after = saved.json()
    assert after["revision"] == before["revision"] + 1
    assert after["session_timeout_minutes"] == 30
    assert after["password_min_length"] == 16
    assert after["ip_allow_list"] == ["127.0.0.0/24", "127.0.0.1/32", "2001:db8::/64"]
    assert client.get("/api/workspace/security").json() == after
    stale = client.patch(
        "/api/workspace/security",
        json={
            "revision": before["revision"],
            "session_timeout_minutes": 480,
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "stale_revision"
    assert client.get("/api/workspace/security").json() == after
    public = client.get("/api/workspace").json()
    assert not (set(_FIELDS) - {"revision"}) & set(public)
    with Session(owner) as db:
        profile = db.scalar(select(WorkspaceProfile))
        assert profile is not None
        assert profile.performed_by == local_id
        audit = db.scalar(
            select(AuditLog)
            .where(AuditLog.entity_id == profile.id)
            .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        )
        assert audit is not None
        assert audit.performed_by == local_id
        assert audit.after["ip_allow_list"] == REDACTED
        assert "127.0.0" not in str(audit.before) + str(audit.after)


def test_workspace_security_rejects_invalid_policies_and_admin_lockout_without_writes(
    security_workspace,
):
    client, _local_id, _owner = security_workspace
    initial = client.get("/api/workspace/security").json()
    revision = initial["revision"]
    invalid = [
        {},
        {"session_timeout_minutes": 20},
        {"session_timeout_minutes": True},
        {"session_timeout_minutes": None},
        {"password_min_length": 11},
        {"password_min_length": 129},
        {"password_min_length": True},
        {"password_require_number": 1},
        {"password_require_mixed_case": "true"},
        {"password_require_mixed_case": None},
        {"mfa_policy": "required"},
        {"mfa_policy": None},
        {"ip_allow_list": None},
        {"ip_allow_list": ["private-network"]},
        {"ip_allow_list": ["127.0.0.1/33"]},
        {"ip_allow_list": ["127.0.0.1/32"] * 101},
        {"unknown": True},
    ]
    for fields in invalid:
        response = client.patch("/api/workspace/security", json={"revision": revision, **fields})
        assert response.status_code == 422, fields
        assert client.get("/api/workspace/security").json() == initial
    # A forwarded header never substitutes for the resolved request client address.
    locked_out = client.patch(
        "/api/workspace/security",
        json={
            "revision": revision,
            "ip_allow_list": ["192.0.2.0/24"],
        },
        headers={"X-Forwarded-For": "192.0.2.1"},
    )
    assert locked_out.status_code == 409
    assert locked_out.json()["detail"]["code"] == "ip_lockout"
    assert "192.0.2" not in str(locked_out.json())
    assert client.get("/api/workspace/security").json() == initial
    with TestClient(client.app, base_url=get_settings().public_origin, client=None) as unknown:
        unknown.cookies.update(client.cookies)
        unknown.headers.update(client.headers)
        denied = unknown.patch(
            "/api/workspace/security",
            json={
                "revision": revision,
                "ip_allow_list": ["127.0.0.0/8"],
            },
        )
        assert denied.status_code == 409
        assert denied.json()["detail"]["code"] == "ip_lockout"


def test_workspace_security_denies_demoted_admin_for_read_and_write(security_workspace):
    client, local_id, owner = security_workspace
    initial = client.get("/api/workspace/security").json()
    with Session(owner) as db:
        user = db.get(User, local_id)
        assert user is not None
        user.role = "member"
        db.commit()
    assert client.get("/api/workspace/security").status_code == 403
    assert client.get("/api/workspace/security/caller-ip").status_code == 403
    assert (
        client.patch(
            "/api/workspace/security",
            json={
                "revision": initial["revision"],
                "session_timeout_minutes": 480,
            },
        ).status_code
        == 403
    )
    with Session(owner) as db:
        profile = db.scalar(select(WorkspaceProfile))
        assert profile is not None
        assert profile.revision == initial["revision"]
        assert profile.session_timeout_minutes == initial["session_timeout_minutes"]


@pytest.mark.parametrize("minimum,mixed,number", [(13, False, True), (128, True, False)])
def test_workspace_security_saves_independent_password_rules(
    security_workspace, minimum: int, mixed: bool, number: bool
):
    client, _local_id, _owner = security_workspace
    before = client.get("/api/workspace/security").json()
    fields = {
        "password_min_length": minimum,
        "password_require_mixed_case": mixed,
        "password_require_number": number,
    }
    saved = client.patch("/api/workspace/security", json={"revision": before["revision"], **fields})
    assert saved.status_code == 200
    after = saved.json()
    assert {key: after[key] for key in fields} == fields
    assert after["revision"] == before["revision"] + 1
    assert client.get("/api/workspace/security").json() == after
    # A partial toggle is independent too; unchanged values retain their revision-bound state.
    toggled = client.patch(
        "/api/workspace/security",
        json={"revision": after["revision"], "password_require_number": not number},
    )
    assert toggled.status_code == 200
    assert toggled.json()["password_require_number"] is not number
    assert toggled.json()["password_min_length"] == minimum
    assert toggled.json()["password_require_mixed_case"] is mixed


def test_workspace_security_caller_ip_uses_authenticated_peer_without_policy_write(
    security_workspace,
):
    client, _local_id, _owner = security_workspace
    before = client.get("/api/workspace/security").json()
    path = "/api/workspace/security/caller-ip"
    response = client.get(path, headers={"X-Forwarded-For": "192.0.2.90"})
    assert response.status_code == 200
    assert response.json() == {"address": "127.0.0.1"}
    assert response.headers["cache-control"] == "no-store"
    assert client.get("/api/workspace/security").json() == before
    with TestClient(client.app, base_url=get_settings().public_origin) as anonymous:
        assert anonymous.get(path).status_code == 401
    assert (
        client.patch(
            "/api/workspace/security",
            json={"revision": before["revision"], "ip_allow_list": ["127.0.0.1"]},
        ).status_code
        == 200
    )
    with TestClient(
        client.app, base_url=get_settings().public_origin, client=("192.0.2.90", 50000)
    ) as excluded:
        excluded.cookies.update(client.cookies)
        denied = excluded.get(path, headers={"X-Forwarded-For": "127.0.0.1"})
        assert denied.status_code == 403
        assert denied.json()["detail"]["code"] == "ip_not_allowed"


@pytest.mark.parametrize("peer", [None, ("not-an-address", 50000)])
def test_workspace_security_caller_ip_reports_unavailable_peer(security_workspace, peer):
    client, _local_id, _owner = security_workspace
    before = client.get("/api/workspace/security").json()
    with TestClient(client.app, base_url=get_settings().public_origin, client=peer) as unknown:
        unknown.cookies.update(client.cookies)
        response = unknown.get("/api/workspace/security/caller-ip")
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "caller_address_unavailable"
    assert client.get("/api/workspace/security").json() == before


def test_workspace_timeout_is_persisted_on_login_and_cached_browser_refresh(security_workspace):
    client, local_id, owner = security_workspace
    initial = client.get("/api/workspace/security").json()
    assert (
        client.patch(
            "/api/workspace/security",
            json={
                "revision": initial["revision"],
                "session_timeout_minutes": 15,
            },
        ).status_code
        == 200
    )
    inventory = client.get("/api/auth/sessions").json()
    session_id = UUID(next(row["id"] for row in inventory if row["current"]))
    assert client.post("/api/auth/refresh").status_code == 200
    with Session(owner) as db:
        session = db.get(IdentitySession, session_id)
        assert session is not None and session.user_id == local_id
        assert (session.expires_at - session.refreshed_at).total_seconds() == 15 * 60
        refreshed_at = session.refreshed_at
        expires_at = session.expires_at
    assert client.post("/api/auth/refresh").status_code == 200
    with Session(owner) as db:
        session = db.get(IdentitySession, session_id)
        assert session is not None
        assert session.refreshed_at > refreshed_at
        assert session.expires_at > expires_at
        assert isinstance(session.refreshed_at, datetime)
        assert (session.expires_at - session.refreshed_at).total_seconds() == 15 * 60
