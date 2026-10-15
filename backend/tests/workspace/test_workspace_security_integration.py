"""Workspace security contracts through signed sessions (fake provider) and the runtime DB role."""

from datetime import datetime
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.membership import sole_active_membership
from app.systems.access.users.models import User
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.audit.snapshots import REDACTED
from app.systems.manage.workspace.models import PlatformSettings, WorkspaceProfile

pytest_plugins = ("tests.fake_provider_support",)
pytestmark = pytest.mark.integration

_FIELDS = (
    "revision",
    "session_timeout_minutes",
    "session_retention_days",
    "security_event_retention_days",
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
def security_workspace(fake_provider_account):
    email, password, provider_id, local_id, owner = fake_provider_account
    with Session(owner) as db:
        user = db.get(User, local_id)
        assert user is not None
        user.supabase_user_id = provider_id
        membership = sole_active_membership(db, local_id)
        membership.role = "admin"
        profile = db.get(WorkspaceProfile, membership.org_id)
        platform = db.scalar(select(PlatformSettings))
        assert profile is not None
        original = {
            field: getattr(platform if field in PlatformSettings.__table__.columns
                           and field != "revision" else profile, field)
            for field in _FIELDS
        }
        platform_revision = platform.revision
        platform.session_timeout_minutes = 60
        platform.session_retention_days = platform.security_event_retention_days = 365
        platform.password_min_length = 12
        platform.password_require_mixed_case = True
        platform.password_require_number = False
        profile.mfa_require_admin = profile.mfa_require_member = profile.mfa_require_guest = False
        profile.mfa_grace_days = 0
        platform.session_absolute_lifetime_minutes = platform.session_concurrent_limit = None
        platform.login_failed_attempt_threshold = 5
        platform.login_window_minutes = platform.login_cooldown_minutes = 15
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
            profile = db.get(WorkspaceProfile, sole_active_membership(db, local_id).org_id)
            platform = db.scalar(select(PlatformSettings))
            assert profile is not None
            for field, value in original.items():
                setattr(platform if field in PlatformSettings.__table__.columns
                        and field != "revision" else profile, field, value)
            platform.revision = platform_revision
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
    invalid += [
        {field: value}
        for field in ("session_retention_days", "security_event_retention_days")
        for value in (None, True, False, "365", 365.0, 0, 3651)
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
        sole_active_membership(db, local_id).role = "member"
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
        platform = db.scalar(select(PlatformSettings))
        assert platform.session_timeout_minutes == initial["session_timeout_minutes"]


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


def test_policy_event_records_only_actual_change_and_noop_stale_saves_do_not_emit(
    security_workspace,
):
    from app.systems.manage.audit.models import SecurityEvent

    client, actor_id, owner = security_workspace
    with Session(owner) as db:
        prior_ids = set(
            db.scalars(
                select(SecurityEvent.id).where(
                    SecurityEvent.event_type == "workspace.security_policy_change",
                    SecurityEvent.actor_id == actor_id,
                )
            )
        )
    initial = client.get("/api/workspace/security").json()
    saved = client.patch(
        "/api/workspace/security",
        json={
            "revision": initial["revision"],
            "session_timeout_minutes": 30,
            "password_require_mixed_case": initial["password_require_mixed_case"],
        },
    )
    assert saved.status_code == 200
    with Session(owner) as db:
        rows = list(
            db.scalars(
                select(SecurityEvent).where(
                    SecurityEvent.event_type == "workspace.security_policy_change",
                    SecurityEvent.actor_id == actor_id,
                )
            )
        )
        rows = [r for r in rows if r.id not in prior_ids]
        assert len(rows) == 1
        row = rows[0]
        assert row.subject_id is None and row.outcome == "success"
        assert row.event_metadata == {
            "changed_fields": ["session_timeout_minutes"],
            "revision": saved.json()["revision"],
            "ip_address": "127.0.0.1",
        }
        event_id = row.id
    assert (
        client.patch(
            "/api/workspace/security",
            json={"revision": initial["revision"], "session_timeout_minutes": 60},
        ).status_code
        == 409
    )
    equal = client.patch(
        "/api/workspace/security",
        json={"revision": saved.json()["revision"], "session_timeout_minutes": 30},
    )
    assert equal.status_code == 200
    empty = client.patch("/api/workspace/security", json={"revision": equal.json()["revision"]})
    assert empty.status_code == 422
    assert client.get("/api/workspace/security").json()["revision"] == equal.json()["revision"]
    with Session(owner) as db:
        current_ids = set(
            db.scalars(
                select(SecurityEvent.id).where(
                    SecurityEvent.event_type == "workspace.security_policy_change",
                    SecurityEvent.actor_id == actor_id,
                )
            )
        )
    assert current_ids - prior_ids == {event_id}


def test_policy_and_event_rollback_together_when_commit_fails(security_workspace, monkeypatch):
    from sqlalchemy.exc import SQLAlchemyError

    from app.core.database.session import AuditSession
    from app.systems.manage.audit.models import SecurityEvent

    client, actor_id, owner = security_workspace
    initial = client.get("/api/workspace/security").json()
    with Session(owner) as db:
        prior_ids = set(
            db.scalars(
                select(SecurityEvent.id).where(
                    SecurityEvent.event_type == "workspace.security_policy_change",
                    SecurityEvent.actor_id == actor_id,
                )
            )
        )
    original = AuditSession.commit
    fault = [True]

    def fail_once(db):
        if fault.pop() if fault else False:
            raise SQLAlchemyError("private commit failure")
        return original(db)

    monkeypatch.setattr(AuditSession, "commit", fail_once)
    result = client.patch(
        "/api/workspace/security",
        json={"revision": initial["revision"], "session_timeout_minutes": 30},
    )
    assert result.status_code == 503
    assert client.get("/api/workspace/security").json() == initial
    with Session(owner) as db:
        assert (
            set(
                db.scalars(
                    select(SecurityEvent.id).where(
                        SecurityEvent.event_type == "workspace.security_policy_change",
                        SecurityEvent.actor_id == actor_id,
                    )
                )
            )
            == prior_ids
        )


def test_retention_defaults_independent_updates_and_omissions_preserve_policy(security_workspace):
    client, actor_id, owner = security_workspace
    before = client.get("/api/workspace/security").json()
    assert before.get("session_retention_days") == 365
    assert before.get("security_event_retention_days") == 365
    fields = ("session_retention_days", "security_event_retention_days")
    try:
        first = client.patch(
            "/api/workspace/security",
            json={"revision": before["revision"], "session_retention_days": 1},
        )
        assert first.status_code == 200
        assert first.json()["session_retention_days"] == 1
        assert first.json()["security_event_retention_days"] == 365
        second = client.patch(
            "/api/workspace/security",
            json={"revision": first.json()["revision"], "security_event_retention_days": 3650},
        )
        assert second.status_code == 200
        assert second.json()["session_retention_days"] == 1
        assert second.json()["security_event_retention_days"] == 3650
        assert client.get("/api/workspace/security").json() == second.json()
        assert not set(fields) & client.get("/api/workspace").json().keys()
        with Session(owner) as db:
            profile = db.scalar(select(PlatformSettings))
            assert profile.performed_by == actor_id
    finally:
        with Session(owner) as db:
            profile = db.scalar(select(PlatformSettings))
            for field in fields:
                setattr(profile, field, before[field])
            db.commit()
