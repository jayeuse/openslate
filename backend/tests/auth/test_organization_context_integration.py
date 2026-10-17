"""Organization selection uses signed identity and committed PostgreSQL authority."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import Membership, User
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.conftest import create_member, create_organization

pytest_plugins = ("tests.auth.session_policy_support",)
pytestmark = pytest.mark.integration


@pytest.fixture
def organizations(policy_world):
    world = policy_world
    with Session(world.owner) as db:
        original = db.scalar(select(Membership).where(Membership.user_id == world.actor_id))
        first_id = original.org_id
        second = create_organization(db, display_name="Second organization")
        other = create_organization(db, display_name="Not a member")
        create_member(db, second, user=db.get(User, world.actor_id), role="member")
        second_id, other_id = second.id, other.id
        db.commit()
    try:
        yield world, first_id, second_id, other_id
    finally:
        with Session(world.owner) as db:
            for row in db.scalars(select(IdentitySession).where(
                IdentitySession.user_id == world.actor_id
            )):
                row.active_org_id = first_id
            for row in db.scalars(select(Membership).where(
                Membership.org_id.in_([second_id, other_id])
            )):
                db.delete(row)
            db.flush()
            db.connection().execute(text("DELETE FROM audit_logs WHERE org_id IN (:a, :b)"),
                                    {"a": second_id, "b": other_id})
            for org_id in (second_id, other_id):
                db.delete(db.get(WorkspaceProfile, org_id))
            db.commit()


def test_selection_persists_but_header_overrides_only_this_request(organizations):
    world, first, second, _ = organizations
    headers = world.headers()
    switched = world.client.post("/api/auth/session/organization", headers=headers,
                                 json={"org_id": str(second)})
    assert switched.status_code == 200
    assert switched.json()["current_organization"]["org_id"] == str(second)
    assert switched.json()["role"] == "member"
    assert {row["org_id"] for row in switched.json()["memberships"]} == {str(first), str(second)}
    overridden = world.client.get("/api/auth/me", headers={**headers, "X-Org": str(first)})
    assert overridden.status_code == 200
    assert overridden.json()["role"] == "admin"
    assert overridden.json()["current_organization"]["org_id"] == str(first)
    assert "no-store" in overridden.headers["cache-control"]
    assert world.client.get("/api/auth/me", headers=headers).json()[
        "current_organization"]["org_id"] == str(second)
    refreshed = world.client.post("/api/auth/token/refresh",
                                  json={"refresh_token": world.handles[0]})
    assert refreshed.status_code == 200
    assert world.client.get("/api/auth/me", headers=world.headers()).json()[
        "current_organization"]["org_id"] == str(second)
    with Session(world.owner) as db:
        assert db.get(IdentitySession, world.session_ids[0]).active_org_id == second


@pytest.mark.parametrize("kind,status,code", [
    ("unknown", 404, None), ("nonmember", 403, "organization_required"),
    ("pending", 403, "organization_required"), ("disabled", 403, "organization_required"),
    ("deleted", 403, "organization_required"), ("expired", 403, "organization_required"),
    ("unaccepted", 403, "organization_required"), ("mfa", 403, "mfa_required"),
    ("ip", 403, "ip_not_allowed"), ("invalid", 422, None),
])
def test_refused_entry_never_changes_the_selected_organization(organizations, kind, status, code):
    world, first, second, other = organizations
    with Session(world.owner) as db:
        membership = db.scalar(select(Membership).where(
            Membership.user_id == world.actor_id, Membership.org_id == second))
        org = db.get(WorkspaceProfile, second)
        if kind in {"pending", "disabled"}:
            membership.status = kind
        elif kind == "deleted":
            membership.is_deleted = True
        elif kind == "expired":
            membership.expires_at = world.clock - timedelta(seconds=1)
        elif kind == "unaccepted":
            membership.invitation_sent_at = world.clock
        elif kind == "mfa":
            org.mfa_require_member = True
        elif kind == "ip":
            org.ip_allow_list = ["192.0.2.0/24"]
        db.commit()
    target = str(uuid4()) if kind == "unknown" else str(other) if kind == "nonmember" else (
        "not-a-uuid" if kind == "invalid" else str(second))
    for response in (
        world.client.post("/api/auth/session/organization", headers=world.headers(),
                          json={"org_id": target}),
        world.client.get("/api/auth/me", headers={**world.headers(), "X-Org": target}),
    ):
        assert response.status_code == status
        if code:
            assert response.json()["detail"]["code"] == code
    with Session(world.owner) as db:
        assert db.get(IdentitySession, world.session_ids[0]).active_org_id == first


def test_account_without_membership_retains_only_account_flows(policy_world):
    world = policy_world
    with Session(world.owner) as db:
        membership = db.scalar(select(Membership).where(Membership.user_id == world.actor_id))
        membership_id = membership.id
        membership.status = "pending"
        db.commit()
    # Losing an organization does not strand an already signed-in global account.
    assert world.client.get("/api/auth/me", headers=world.headers()).status_code == 200
    world.login_slot = 4
    login = world.client.post("/api/auth/login", json={"email": world.email,
                                                     "password": world.password})
    assert login.status_code == 200
    csrf = world.client.cookies.get("openslate_csrf")
    me = world.client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["id"] == str(world.actor_id)
    assert me.json()["memberships"] == []
    assert me.json()["current_organization"] is None
    assert me.json()["role"] is None and me.json()["access"] == []
    denied = world.client.get("/api/boards")
    assert denied.status_code == 403
    assert denied.json()["detail"]["code"] == "organization_required"
    profile = world.client.patch("/api/auth/me/profile", headers={"X-CSRF-Token": csrf},
                                 json={"display_name": "Account only"})
    assert profile.status_code == 200 and profile.json()["display_name"] == "Account only"
    assert world.client.get(f"/api/users/{world.actor_id}/preferences").status_code == 200
    assert world.client.patch(f"/api/users/{world.actor_id}/preferences",
                              headers={"X-CSRF-Token": csrf},
                              json={"theme": "dark"}).status_code == 200
    assert world.client.get(f"/api/users/{world.target_id}/preferences").status_code == 403
    assert world.client.get("/api/auth/sessions").status_code == 200
    assert world.client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 204
    # Restore fixture's original active authority after exercising the absence.
    with Session(world.owner) as db:
        db.get(Membership, membership_id).status = "active"
        db.commit()


def test_cookie_selection_requires_origin_csrf_and_rejects_mixed_credentials(organizations):
    world, _, second, _ = organizations
    world.login_slot = 4
    assert world.client.post("/api/auth/login", json={"email": world.email,
                                                     "password": world.password}).status_code == 200
    payload = {"org_id": str(second)}
    assert world.client.post("/api/auth/session/organization", json=payload).status_code == 401
    headers = {"X-CSRF-Token": world.client.cookies.get("openslate_csrf")}
    assert world.client.post("/api/auth/session/organization", headers={
        **headers, "Origin": "https://other.example.test"}, json=payload).status_code == 401
    assert world.client.post("/api/auth/session/organization", headers={
        **headers, **world.headers()}, json=payload).status_code == 401
    assert world.client.post("/api/auth/session/organization", headers=headers,
                             json=payload).status_code == 200


def test_selection_waiting_for_revocation_cannot_resurrect_the_session(organizations):
    world, first, second, _ = organizations
    admitted, release = Event(), Event()
    from app.core.database.session import AuditSession

    def revoke():
        with Session(world.owner) as db:
            row = db.get(IdentitySession, world.session_ids[0], with_for_update=True)
            row.revoked_at = world.clock
            db.flush()
            admitted.set()
            assert release.wait(10)
            db.commit()

    # Signal the actual lock acquisition, not elapsed time or a retry loop.
    original = AuditSession.get
    def get(db, entity, *args, **kwargs):
        if entity is IdentitySession and kwargs.get("with_for_update"):
            release.set()
        return original(db, entity, *args, **kwargs)

    from unittest.mock import patch
    with ThreadPoolExecutor(max_workers=1) as pool, patch.object(AuditSession, "get", get):
        future = pool.submit(revoke)
        assert admitted.wait(10)
        response = world.client.post("/api/auth/session/organization", headers=world.headers(),
                                     json={"org_id": str(second)})
        release.set()
        future.result(timeout=10)
    assert response.status_code in {401, 403}
    with Session(world.owner) as db:
        row = db.get(IdentitySession, world.session_ids[0])
        assert row.revoked_at is not None and row.active_org_id == first


@pytest.mark.parametrize("route", ["/api/auth/invitations", "/api/users"])
def test_existing_account_invitation_is_pending_until_its_owner_accepts(organizations, route):
    world, first, second, _ = organizations
    with Session(world.owner) as db:
        # Invitation administration retains the S04 sole-membership bridge until S07.
        db.delete(db.scalar(select(Membership).where(
            Membership.user_id == world.actor_id, Membership.org_id == second)))
        db.delete(db.scalar(select(Membership).where(Membership.user_id == world.target_id)))
        admin = db.get(User, world.target_id)
        # A different signed-in account is not simulated as the invitation owner.
        target_email, target_username = admin.email, admin.username
        target_binding = admin.supabase_user_id
        db.commit()
    invited = world.client.post(route, headers=world.headers(), json={
        "email": target_email, "username": "proposed_label"})
    assert invited.status_code == 201
    assert invited.json()["delivery"] == "in_app"
    assert invited.json()["user"]["status"] == "pending"
    with Session(world.owner) as db:
        rows = db.scalars(select(Membership).where(Membership.user_id == world.target_id)).all()
        assert len(rows) == 1 and rows[0].org_id == first and rows[0].status == "pending"
        invitation_id = rows[0].id
        assert db.get(User, world.target_id).supabase_user_id == target_binding
        assert db.get(User, world.target_id).status == "active"
        assert db.get(User, world.target_id).username == target_username
    assert not any(method == "DELETE" or path in {"/auth/v1/invite", "/auth/v1/admin/users"}
                   for method, path in world.calls)
    assert world.client.post(f"/api/auth/invitations/{invitation_id}/accept",
                              headers=world.headers()).status_code == 404
    duplicate = world.client.post("/api/auth/invitations", headers=world.headers(), json={
        "email": target_email, "username": target_username})
    assert duplicate.status_code == 409


@pytest.mark.parametrize("kind,code", [
    ("mfa", "mfa_required"), ("ip", "ip_not_allowed"),
    ("pending", "organization_required"), ("expired", "organization_required"),
])
def test_blocked_saved_organization_preserves_account_flows_but_not_entry(policy_world, kind, code):
    world = policy_world
    with Session(world.owner) as db:
        membership = db.scalar(select(Membership).where(Membership.user_id == world.actor_id))
        org_id, membership_id = membership.org_id, membership.id
        org = db.get(WorkspaceProfile, org_id)
        if kind == "mfa":
            org.mfa_require_admin = True
        elif kind == "ip":
            org.ip_allow_list = ["192.0.2.0/24"]
        elif kind == "pending":
            membership.status = "pending"
        else:
            membership.expires_at = world.clock - timedelta(seconds=1)
        db.commit()
    try:
        # Session probes use cookies, as the browser does; no auth override.
        world.client.cookies.set("openslate_access", world.access())
        for path in ("/api/auth/me", "/api/auth/session"):
            response = world.client.get(path)
            assert response.status_code == 200
            assert response.json()["default_organization_blocked"] == code
            if path.endswith("/me"):
                assert response.json()["current_organization"] is None
                assert response.json()["role"] is None and response.json()["access"] == []
            else:
                assert response.json()["authenticated"] is True
            explicit = world.client.get(path, headers={"X-Org": str(org_id)})
            assert explicit.status_code == 403
            assert explicit.json()["detail"]["code"] == code
        world.client.cookies.clear()
        profile = world.client.patch("/api/auth/me/profile", headers=world.headers(),
                                     json={"display_name": "Still my account"})
        assert profile.status_code == 200
        assert profile.json()["display_name"] == "Still my account"
        assert profile.json()["current_organization"] is None
        assert profile.json()["default_organization_blocked"] == code
        denied = world.client.get("/api/boards", headers=world.headers())
        assert denied.status_code == 403
        assert denied.json()["detail"]["code"] == code
        selected = world.client.post("/api/auth/session/organization", headers=world.headers(),
                                     json={"org_id": str(org_id)})
        assert selected.status_code == 403 and selected.json()["detail"]["code"] == code
        with Session(world.owner) as db:
            assert db.get(IdentitySession, world.session_ids[0]).active_org_id == org_id
    finally:
        world.client.cookies.clear()
        with Session(world.owner) as db:
            membership = db.get(Membership, membership_id)
            membership.status, membership.expires_at = "active", None
            db.commit()


def test_account_owned_factor_still_requires_aal2_without_an_organization(policy_world):
    from app.systems.access.identity.provider_user_cache import forget_provider_user

    world = policy_world
    with Session(world.owner) as db:
        db.get(IdentitySession, world.session_ids[0]).active_org_id = None
        db.commit()
    world.factor_status = "verified"
    forget_provider_user(world.provider_id)
    world.client.cookies.set("openslate_access", world.access())
    for path in ("/api/auth/me", "/api/auth/session"):
        denied = world.client.get(path)
        assert denied.status_code == 403 and denied.json()["detail"]["code"] == "mfa_required"
    world.client.cookies.clear()
    denied = world.client.patch("/api/auth/me/profile", headers=world.headers(),
                                json={"display_name": "Not admitted"})
    assert denied.status_code == 403 and denied.json()["detail"]["code"] == "mfa_required"
    admitted = world.client.get("/api/auth/me", headers=world.headers("aal2"))
    assert admitted.status_code == 200
    assert admitted.json()["current_organization"] is None
    assert admitted.json()["default_organization_blocked"] is None


@pytest.mark.parametrize("state,expected", [("pending", 204), ("expired", 409),
                                          ("disabled", 409), ("accepted", 409)])
def test_signed_account_accepts_only_own_live_pending_membership(organizations, state, expected):
    world, _, second, _ = organizations
    with Session(world.owner) as db:
        membership = db.scalar(select(Membership).where(
            Membership.user_id == world.actor_id, Membership.org_id == second))
        membership.status = "pending" if state in {"pending", "expired"} else (
            "disabled" if state == "disabled" else "active")
        membership.invitation_sent_at = world.clock - timedelta(days=8 if state == "expired" else 0)
        membership.provider_invitation_operation_id = uuid4()
        membership.invitation_accepted_at = world.clock if state == "accepted" else None
        invitation_id = membership.id
        db.commit()
    before = world.client.get("/api/auth/me", headers=world.headers())
    assert before.status_code == 200
    if state == "pending":
        assert any(row["id"] == str(invitation_id) for row in before.json()["pending_invitations"])
    accepted = world.client.post(f"/api/auth/invitations/{invitation_id}/accept",
                                 headers=world.headers())
    assert accepted.status_code == expected
    with Session(world.owner) as db:
        row = db.get(Membership, invitation_id)
        audit = list(db.scalars(select(AuditLog).where(AuditLog.entity_type == "memberships",
                                                      AuditLog.entity_id == invitation_id)))
        if expected == 204:
            assert row.status == "active" and row.invitation_accepted_at is not None
            assert any(change.performed_by == world.actor_id
                       and change.after.get("status") == "active" for change in audit)
        else:
            assert row.status == ("pending" if state == "expired" else (
                "disabled" if state == "disabled" else "active"))
