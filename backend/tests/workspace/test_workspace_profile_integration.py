"""Organization profile privacy through signed sessions (fake provider) and the runtime role."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.main import create_app
from app.systems.access.users.models import User
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.audit.snapshots import REDACTED
from app.systems.manage.workspace.models import WorkspaceProfile

pytest_plugins = ("tests.fake_provider_support",)
pytestmark = pytest.mark.integration
CONTACT_FIELDS = {"contact_email", "contact_phone", "postal_address"}
PROFILE_VALUES = {
    "legal_name": "Harbor Profile Test",
    "description": "A plain organization description.",
    "contact_email": "private-profile@example.test",
    "contact_phone": "+63 555 0100",
    "postal_address": "Profile Street\nTest City",
}


@pytest.fixture
def profile_client(fake_provider_account):
    email, password, provider_id, actor_id, owner = fake_provider_account
    with Session(owner) as db:
        user = db.get(User, actor_id)
        assert user is not None
        original_user = {
            key: getattr(user, key)
            for key in ("role", "supabase_user_id", "sponsor_user_id", "expires_at")
        }
        user.supabase_user_id = provider_id
        user.role = "admin"
        profile = db.scalar(select(WorkspaceProfile))
        assert profile is not None
        original_profile = {key: getattr(profile, key) for key in (*PROFILE_VALUES, "revision")}
        for key, value in PROFILE_VALUES.items():
            setattr(profile, key, value)
        db.commit()
    client = TestClient(
        create_app(), base_url=get_settings().public_origin, client=("127.0.0.1", 50000)
    )
    client.headers["Origin"] = get_settings().public_origin
    try:
        login = client.post("/api/auth/login", json={"email": email, "password": password})
        assert login.status_code == 200
        csrf = client.cookies.get("openslate_csrf")
        assert csrf
        client.headers["X-CSRF-Token"] = csrf
        yield client, actor_id, owner
    finally:
        client.close()
        with Session(owner) as db:
            user = db.get(User, actor_id)
            assert user is not None
            sponsor_id = user.sponsor_user_id
            for key, value in original_user.items():
                setattr(user, key, value)
            db.flush()
            if sponsor_id is not None and sponsor_id != original_user["sponsor_user_id"]:
                sponsor = db.get(User, sponsor_id)
                assert sponsor is not None
                db.delete(sponsor)
            profile = db.scalar(select(WorkspaceProfile))
            assert profile is not None
            for key, value in original_profile.items():
                setattr(profile, key, value)
            db.commit()


def _role(owner, actor_id, role):
    with Session(owner) as db:
        user = db.get(User, actor_id)
        assert user is not None
        if role == "guest" and user.sponsor_user_id is None:
            sponsor = User(
                email=f"profile-sponsor-{uuid4().hex}@example.test",
                username=f"profile-sponsor-{uuid4().hex[:12]}",
                status="active",
                role="admin",
            )
            db.add(sponsor)
            db.flush()
            user.sponsor_user_id = sponsor.id
            user.expires_at = datetime.now(UTC) + timedelta(days=1)
        user.role = role
        db.commit()


def _audit_count(owner):
    with Session(owner) as db:
        profile = db.scalar(select(WorkspaceProfile))
        assert profile is not None
        return db.scalar(
            select(func.count()).select_from(AuditLog).where(AuditLog.entity_id == profile.id)
        )


def test_guest_workspace_omits_exactly_contact_fields(profile_client):
    client, actor_id, owner = profile_client
    full = client.get("/api/workspace")
    assert full.status_code == 200
    full_body = full.json()
    assert {key: full_body[key] for key in PROFILE_VALUES} == PROFILE_VALUES
    _role(owner, actor_id, "guest")
    before_audits = _audit_count(owner)
    guest = client.get("/api/workspace")
    assert guest.status_code == 200
    body = guest.json()
    assert CONTACT_FIELDS.isdisjoint(body)
    assert body == {key: value for key, value in full_body.items() if key not in CONTACT_FIELDS}
    assert guest.headers["Cache-Control"] == "no-store"
    assert _audit_count(owner) == before_audits


@pytest.mark.parametrize("role", ["admin", "member"])
@pytest.mark.parametrize("contacts", ["populated", "mixed", "null"])
def test_full_workspace_retains_all_contact_keys(profile_client, role, contacts):
    client, actor_id, owner = profile_client
    _role(owner, actor_id, role)
    expected = {key: PROFILE_VALUES[key] for key in CONTACT_FIELDS}
    if contacts == "mixed":
        expected["contact_phone"] = None
    elif contacts == "null":
        expected = {key: None for key in CONTACT_FIELDS}
    with Session(owner) as db:
        profile = db.scalar(select(WorkspaceProfile))
        assert profile is not None
        for key, value in expected.items():
            setattr(profile, key, value)
        db.commit()
        revision = profile.revision
    before_audits = _audit_count(owner)
    response = client.get("/api/workspace")
    assert response.status_code == 200
    body = response.json()
    assert CONTACT_FIELDS <= body.keys()
    assert {key: body[key] for key in CONTACT_FIELDS} == expected
    assert body["legal_name"] == PROFILE_VALUES["legal_name"]
    assert body["description"] == PROFILE_VALUES["description"]
    assert body["revision"] == revision
    assert _audit_count(owner) == before_audits


def test_admin_profile_save_clear_and_omission_are_full_and_audited(profile_client):
    client, actor_id, owner = profile_client
    before = client.get("/api/workspace").json()
    before_audits = _audit_count(owner)
    saved = client.patch(
        "/api/workspace",
        json={
            "revision": before["revision"],
            "legal_name": "  Changed legal name  ",
            "description": "  Changed description  ",
            "contact_email": "  PROFILE@EXAMPLE.COM  ",
            "contact_phone": "  +63 555 0200  ",
            "postal_address": "  New street\nTest City  ",
        },
    )
    assert saved.status_code == 200
    accepted = saved.json()
    assert {key: accepted[key] for key in PROFILE_VALUES} == {
        "legal_name": "Changed legal name",
        "description": "Changed description",
        "contact_email": "profile@example.com",
        "contact_phone": "+63 555 0200",
        "postal_address": "New street\nTest City",
    }
    assert accepted["revision"] == before["revision"] + 1
    assert accepted["theme"] == before["theme"]
    assert client.get("/api/workspace").json() == accepted
    assert _audit_count(owner) == before_audits + 1
    with Session(owner) as db:
        profile = db.scalar(select(WorkspaceProfile))
        audit = db.scalar(
            select(AuditLog)
            .where(AuditLog.entity_id == profile.id)
            .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        )
        assert audit is not None and audit.performed_by == actor_id
        assert audit.after["legal_name"] == "Changed legal name"
        assert audit.after["description"] == "Changed description"
        for key in CONTACT_FIELDS:
            assert audit.before[key] == REDACTED and audit.after[key] == REDACTED
            assert PROFILE_VALUES[key] not in str(audit.before)
            assert accepted[key] not in str(audit.after)
    one = client.patch(
        "/api/workspace", json={"revision": accepted["revision"], "legal_name": None}
    )
    assert one.status_code == 200
    assert one.json()["legal_name"] is None
    for key in PROFILE_VALUES.keys() - {"legal_name"}:
        assert one.json()[key] == accepted[key]
    cleared = client.patch(
        "/api/workspace",
        json={"revision": one.json()["revision"], **dict.fromkeys(PROFILE_VALUES)},
    )
    assert cleared.status_code == 200
    assert {key: cleared.json()[key] for key in PROFILE_VALUES} == dict.fromkeys(PROFILE_VALUES)
    assert CONTACT_FIELDS <= cleared.json().keys()
    assert client.get("/api/workspace").json() == cleared.json()
