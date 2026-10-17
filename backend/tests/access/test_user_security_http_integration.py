"""Person security actions through signed Auth, PostgreSQL and provider HTTP boundaries."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.systems.access.identity.models import IdentityMfaObservation, IdentitySession
from app.systems.access.users.models import Membership, PlatformOperator, User
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.access.user_admin_support import add_session
from tests.access.user_security_support import open_security_world
from tests.conftest import create_member, create_organization, make_operator, membership_of

pytest_plugins = ("tests.fake_provider_support",)
pytestmark = pytest.mark.integration


@pytest.fixture
def world(fake_provider_account, monkeypatch):
    yield from open_security_world(fake_provider_account, monkeypatch)


@pytest.fixture
def peer(world):
    with Session(world.owner) as db:
        peer = create_organization(db)
        peer_id = peer.id
        db.commit()
    try:
        yield peer_id
    finally:
        with Session(world.owner) as db:
            for row in db.scalars(select(Membership).where(Membership.org_id == peer_id)):
                db.delete(row)
            for row in db.scalars(select(PlatformOperator).where(
                PlatformOperator.user_id == world.actor_id,
            )):
                db.delete(row)
            db.flush()
            db.delete(db.get(WorkspaceProfile, peer_id))
            db.commit()


@pytest.mark.parametrize("operator", [False, True])
def test_admitted_admin_session_surfaces_hide_foreign_people(world, peer, operator):
    with Session(world.owner) as db:
        membership_of(db, world.target_id).org_id = peer
        if not operator:
            db.delete(db.scalars(select(PlatformOperator).where(
                PlatformOperator.user_id == world.actor_id,
            )).one())
        db.commit()
    assert world.client.get("/api/users", headers=world.headers()).status_code == 200
    listed = world.client.get("/api/auth/admin-sessions", headers=world.headers())
    assert listed.status_code == 200, listed.text
    assert {row["user_id"] for row in listed.json()["items"]} == {str(world.actor_id)}
    session = world.sessions()[0]
    for method, suffix in (("GET", ""), ("DELETE", f"/{session.id}"), ("DELETE", "")):
        refused = world.client.request(
            method, f"/api/users/{world.target_id}/sessions{suffix}", headers=world.headers(),
        )
        assert refused.status_code == 404, refused.text
    ended = world.client.delete("/api/auth/admin-sessions", headers=world.headers())
    assert ended.status_code == 204
    assert ended.headers["X-Skipped-Shared-Accounts"] == "0"
    assert all(row.revoked_at is None for row in world.sessions())


@pytest.mark.parametrize("operator", [False, True])
def test_shared_person_sessions_are_visible_but_only_operator_revokes(world, peer, operator):
    with Session(world.owner) as db:
        target = db.get(User, world.target_id)
        membership_of(db, target.id).status = "disabled"
        create_member(db, db.get(WorkspaceProfile, peer), user=target)
        add_session(db, db.get(User, world.actor_id))
        if not operator:
            db.delete(db.scalars(select(PlatformOperator).where(
                PlatformOperator.user_id == world.actor_id,
            )).one())
        db.commit()
    listed = world.client.get(
        f"/api/users/{world.target_id}/sessions", headers=world.headers(),
    )
    assert listed.status_code == 200 and listed.json()["items"], listed.text
    session_id = world.sessions()[0].id
    expected = 204 if operator else 409
    for suffix in (f"/{session_id}", ""):
        ended = world.client.delete(
            f"/api/users/{world.target_id}/sessions{suffix}", headers=world.headers(),
        )
        assert ended.status_code == expected, ended.text
    ended = world.client.delete("/api/auth/admin-sessions", headers=world.headers())
    assert ended.status_code == 204
    assert ended.headers["X-Skipped-Shared-Accounts"] == ("0" if operator else "1")
    assert all((row.revoked_at is not None) is operator for row in world.sessions())
    assert world.client.get("/api/users", headers=world.headers()).status_code == 200


@pytest.mark.parametrize("membership_state", ["foreign", "removed"])
def test_person_security_hides_targets_before_provider_observation(world, peer, membership_state):
    with Session(world.owner) as db:
        target_membership = membership_of(db, world.target_id)
        if membership_state == "foreign":
            target_membership.org_id = peer
        else:
            target_membership.is_deleted = True
            target_membership.deleted_at = datetime.now(UTC)
        db.commit()
    assert world.client.get("/api/users", headers=world.headers()).status_code == 200
    world.calls.clear()
    refused = world.client.get(f"/api/users/{world.target_id}/security", headers=world.headers())
    assert refused.status_code == 404, refused.text
    assert not any(path.endswith(str(world.target_provider_id)) for _, path in world.calls)
    assert not world.events()
    with Session(world.owner) as db:
        assert db.get(IdentityMfaObservation, world.target_id) is None


def test_global_restore_requires_operator_and_never_restores_removed_membership(world, peer):
    with Session(world.owner) as db:
        target = db.get(User, world.target_id)
        create_member(db, db.get(WorkspaceProfile, peer), user=target)
        db.commit()
    deleted = world.client.delete(f"/api/users/{world.target_id}", headers=world.headers())
    assert deleted.status_code == 204, deleted.text
    with Session(world.owner) as db:
        operator = db.scalars(select(PlatformOperator).where(
            PlatformOperator.user_id == world.actor_id,
        )).one()
        db.delete(operator)
        db.commit()
    refused = world.client.post(f"/api/users/{world.target_id}/restore", headers=world.headers())
    assert refused.status_code == 409, refused.text
    with Session(world.owner) as db:
        target = db.get(User, world.target_id)
        assert target.is_deleted and target.status == "disabled"
        removed = db.scalars(select(Membership).where(
            Membership.user_id == target.id, Membership.org_id == peer,
        )).one()
        removed.is_deleted, removed.deleted_at = True, datetime.now(UTC)
        make_operator(db, db.get(User, world.actor_id))
        db.commit()
    restored = world.client.post(f"/api/users/{world.target_id}/restore", headers=world.headers())
    assert restored.status_code == 200, restored.text
    with Session(world.owner) as db:
        target = db.get(User, world.target_id)
        assert not target.is_deleted and target.status == "active"
        assert db.scalars(select(Membership).where(
            Membership.user_id == target.id, Membership.org_id == peer,
        )).one().is_deleted
    assert all(row.revoked_at is not None for row in world.sessions())


def test_live_status_requires_real_auth_and_reports_current_enrollment(world):
    path = f"/api/users/{world.target_id}/security"
    assert world.client.get("/api/auth/me", headers=world.headers()).status_code == 200
    status = world.client.get(path, headers=world.headers())
    assert status.status_code == 200, status.text
    assert status.json() == {
        "user_id": str(world.target_id),
        "verified_factor_count": 1,
        "target_eligible": True,
        "smtp_configured": True,
    }
    assert status.headers["Cache-Control"] == "no-store"
    assert world.client.get(path).status_code == 401
    assert not world.events()


@pytest.mark.parametrize(
    "field,value,expected",
    [
        ("role", "member", 403),
        ("status", "disabled", 401),
        ("tokens_valid_after", timedelta(minutes=1), 401),
    ],
)
def test_status_requires_current_actor_authority(world, field, value, expected):
    with Session(world.owner) as db:
        actor = db.get(User, world.actor_id)
        setattr(membership_of(db, actor.id) if field == "role" else actor,
                field, datetime.now(UTC) + value if isinstance(value, timedelta) else value)
        db.commit()
    response = world.client.get(
        f"/api/users/{world.target_id}/security",
        headers=world.headers(),
    )
    assert response.status_code == expected
    assert not any(path.endswith(str(world.target_provider_id)) for _, path in world.calls)


@pytest.mark.parametrize("state", ["disabled", "expired", "pending"])
def test_bound_inactive_status_is_readable_but_not_action_eligible(world, state):
    with Session(world.owner) as db:
        target = db.get(User, world.target_id)
        if state == "expired":
            membership_of(db, target.id).expires_at = datetime.now(UTC) - timedelta(days=1)
        else:
            target.status = state
        db.commit()
    response = world.client.get(
        f"/api/users/{world.target_id}/security",
        headers=world.headers(),
    )
    assert response.status_code == 200, response.text
    assert response.json()["verified_factor_count"] == 1
    assert response.json()["target_eligible"] is False


@pytest.mark.parametrize("state,expected", [("deleted", 404), ("unbound", 409), ("missing", 404)])
def test_status_refuses_missing_deleted_and_unbound_profiles(world, state, expected):
    target_id = world.target_id
    if state == "missing":
        target_id = uuid4()
    else:
        with Session(world.owner) as db:
            target = db.get(User, target_id)
            if state == "deleted":
                target.is_deleted = True
                target.deleted_at = datetime.now(UTC)
            else:
                target.supabase_user_id = None
            db.commit()
    response = world.client.get(f"/api/users/{target_id}/security", headers=world.headers())
    assert response.status_code == expected
    assert "verified_factor_count" not in response.json()


@pytest.mark.parametrize("failure", ["unavailable", "malformed", "wrong_binding"])
def test_provider_status_failure_never_reports_false_mfa_off(world, failure):
    def provider(request):
        if request.url.path != f"/auth/v1/admin/users/{world.target_provider_id}":
            return None
        if failure == "unavailable":
            return httpx.Response(503, json={"private": "Private provider routing detail"})
        if failure == "malformed":
            return httpx.Response(200, json={"id": str(world.target_provider_id), "factors": None})
        return httpx.Response(200, json={"id": str(uuid4()), "email": "foreign@example.test"})

    world.hook = provider
    response = world.client.get(
        f"/api/users/{world.target_id}/security",
        headers=world.headers(),
    )
    assert response.status_code == (409 if failure == "wrong_binding" else 503)
    assert "verified_factor_count" not in response.json()
    assert "Private provider routing detail" not in response.text
    assert "foreign@example.test" not in response.text


def test_status_reports_empty_factors_and_absent_smtp_truthfully(world, monkeypatch):
    world.factors.clear()
    monkeypatch.setattr(get_settings(), "smtp_host", None)
    response = world.client.get(
        f"/api/users/{world.target_id}/security",
        headers=world.headers(),
    )
    assert response.status_code == 200, response.text
    assert response.json()["verified_factor_count"] == 0
    assert response.json()["smtp_configured"] is False


@pytest.mark.parametrize(
    "change,expected", [("role", 403), ("session", 401), ("binding", 409), ("membership", 404)],
)
def test_status_discards_provider_facts_after_authority_or_binding_changes(world, change, expected):
    changed = []

    def during_provider(request):
        if request.url.path == f"/auth/v1/admin/users/{world.target_provider_id}" and not changed:
            changed.append(True)
            with Session(world.owner) as db:
                if change == "role":
                    membership_of(db, world.actor_id).role = "member"
                elif change == "session":
                    db.get(IdentitySession, world.session_id).revoked_at = datetime.now(UTC)
                elif change == "membership":
                    membership_of(db, world.target_id).is_deleted = True
                else:
                    db.get(User, world.target_id).supabase_user_id = uuid4()
                db.commit()
        return None

    world.hook = during_provider
    response = world.client.get(
        f"/api/users/{world.target_id}/security",
        headers=world.headers(),
    )
    assert changed
    assert response.status_code == expected
    assert "verified_factor_count" not in response.json()


@pytest.mark.parametrize(
    "body",
    [
        {"revoke_sessions": None},
        {"revoke_sessions": "false"},
        {"revoke_sessions": 0},
        {"email": "private@example.test"},
    ],
)
def test_recovery_rejects_unknown_null_and_coerced_input(world, body):
    response = world.client.post(
        f"/api/users/{world.target_id}/recovery",
        headers=world.headers(),
        json=body,
    )
    assert response.status_code == 422
    assert not any(path.endswith("/recover") for _, path in world.calls)
    assert all(session.revoked_at is None for session in world.sessions())


def test_email_only_recovery_is_correlated_acceptance_without_revocation(world):
    observed = []

    def during_mail(request):
        if request.url.path.endswith("/recover"):
            observed.extend(world.events())
            assert all(session.revoked_at is None for session in world.sessions())
        return None

    world.hook = during_mail
    response = world.client.post(
        f"/api/users/{world.target_id}/recovery",
        headers=world.headers(),
        json={},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body == {
        "operation_id": body["operation_id"],
        "user_id": str(world.target_id),
        "email_request": "accepted",
        "local_revocation": "not_requested",
        "revoked_sessions": None,
    }
    assert len(observed) == 1 and observed[0].outcome == "attempt"
    events = world.events()
    assert [event.outcome for event in events] == ["attempt", "success"]
    assert all(
        str(event.operation_id) == body["operation_id"] and event.actor_id == world.actor_id
        for event in events
    )
    assert all(session.revoked_at is None for session in world.sessions())
    assert sum(path.endswith("/recover") for _, path in world.calls) == 1
    assert "delivered" not in response.text
    assert "example.test" not in str([event.event_metadata for event in events])


@pytest.mark.parametrize("revoke", [False, True])
def test_smtp_absence_refuses_before_any_recovery_effect(world, monkeypatch, revoke):
    monkeypatch.setattr(get_settings(), "smtp_host", None)
    response = world.client.post(
        f"/api/users/{world.target_id}/recovery",
        headers=world.headers(),
        json={"revoke_sessions": revoke},
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "security_smtp_unconfigured"
    assert not any(path.endswith("/recover") for _, path in world.calls)
    assert all(session.revoked_at is None for session in world.sessions())


def test_recovery_timeout_is_unconfirmed_and_never_replayed(world):
    def timeout(request):
        if request.url.path.endswith("/recover"):
            raise httpx.ReadTimeout("Private provider routing detail")
        return None

    world.hook = timeout
    response = world.client.post(
        f"/api/users/{world.target_id}/recovery",
        headers=world.headers(),
        json={},
    )
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail["email_request"] == "unconfirmed"
    assert detail["local_revocation"] == "not_requested"
    assert sum(path.endswith("/recover") for _, path in world.calls) == 1
    assert "Private provider routing detail" not in response.text
    assert [event.outcome for event in world.events()] == ["attempt", "partial"]
    assert all(session.revoked_at is None for session in world.sessions())


@pytest.mark.parametrize("body", [{"factor_id": str(uuid4())}, {"confirm": True}])
def test_reset_rejects_client_selected_effects(world, body):
    response = world.client.post(
        f"/api/users/{world.target_id}/mfa/reset",
        headers=world.headers("aal2"),
        json=body,
    )
    assert response.status_code == 422
    assert not any(method == "DELETE" for method, _ in world.calls)


def test_reset_requires_presented_aal2_even_if_local_session_is_newer(world):
    from app.systems.access.identity.mfa import _cipher

    with Session(world.owner) as db:
        session = db.get(IdentitySession, world.session_id)
        access = world.headers("aal2")["Authorization"].partition(" ")[2]
        session.provider_access_token_encrypted = _cipher().encrypt(access.encode()).decode()
        db.commit()
    response = world.client.post(
        f"/api/users/{world.target_id}/mfa/reset",
        headers=world.headers(),
        json={},
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "security_aal2_required"
    assert [event.outcome for event in world.events()] == ["denied"]
    assert not any(method == "DELETE" for method, _ in world.calls)
    assert all(session.revoked_at is None for session in world.sessions())


@pytest.mark.parametrize("empty", [False, True])
def test_reset_clears_factors_before_local_revocation_and_handles_zero_factors(world, empty):
    if empty:
        world.factors.clear()
    deleted = []

    def during_delete(request):
        if request.method == "DELETE":
            assert all(session.revoked_at is None for session in world.sessions())
            assert world.events()[0].outcome == "attempt"
            deleted.append(True)
        return None

    world.hook = during_delete
    response = world.client.post(
        f"/api/users/{world.target_id}/mfa/reset",
        headers=world.headers("aal2"),
        json={},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["factors_cleared"] is True and body["local_revocation"] == "committed"
    assert body["revoked_sessions"] == 1
    assert bool(deleted) is not empty
    assert not world.factors
    assert all(session.revoked_at is not None for session in world.sessions())
    assert [event.outcome for event in world.events()] == ["attempt", "success"]


def test_reset_refuses_oversize_inventory_without_truncation_or_effect(world):
    world.factors[:] = [
        {"id": str(uuid4()), "factor_type": "totp", "status": "verified"} for _ in range(33)
    ]
    response = world.client.post(
        f"/api/users/{world.target_id}/mfa/reset",
        headers=world.headers("aal2"),
        json={},
    )
    assert response.status_code == 503
    assert not any(method == "DELETE" for method, _ in world.calls)
    assert all(session.revoked_at is None for session in world.sessions())
