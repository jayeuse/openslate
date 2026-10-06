"""Complete bound factor observations, stale reads and effect cleanup on real PostgreSQL."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.systems.access.identity.models import IdentityMfaObservation
from app.systems.access.users.models import User
from app.systems.manage.audit.models import AuditLog

pytest_plugins = ("tests.auth.session_policy_support",)
pytestmark = pytest.mark.integration


@pytest.fixture
def observation_world(policy_world):
    world = policy_world
    with Session(world.owner) as db:
        row = db.get(IdentityMfaObservation, world.actor_id)
        if row is None:
            db.add(IdentityMfaObservation(user_id=world.actor_id))
        else:
            row.observed_provider_user_id = row.verified_totp = row.observed_at = None
        db.commit()
    return world


def observed(world):
    with Session(world.owner) as db:
        row = db.get(IdentityMfaObservation, world.actor_id)
        return (
            None
            if row is None
            else (row.observed_provider_user_id, row.verified_totp, row.observed_at)
        )


@pytest.mark.parametrize(
    "evidence,expected",
    [("omitted", False), ("empty", False), ("unverified", False), ("verified", True)],
)
def test_self_status_persists_complete_get_evidence_without_profile_audit(
    observation_world, evidence, expected
):
    world = observation_world
    world.factor_status = evidence if evidence in {"unverified", "verified"} else None
    if evidence == "omitted":
        world.hook = lambda request: (
            httpx.Response(200, json={"id": str(world.provider_id), "email": world.email})
            if request.method == "GET"
            and (
                request.url.path.endswith(str(world.provider_id))
                or request.url.path == "/auth/v1/user"
            )
            else None
        )
    with Session(world.owner) as db:
        user = db.get(User, world.actor_id)
        metadata = user.updated_at, user.performed_by
        before_audits = list(
            db.scalars(select(AuditLog.id).where(AuditLog.entity_id == world.actor_id))
        )
    result = world.client.get("/api/auth/mfa", headers=world.headers("aal2"))
    assert result.status_code == 200
    fact = observed(world)
    assert fact[1] is expected
    assert fact[0] == world.provider_id and fact[2] is not None
    with Session(world.owner) as db:
        user = db.get(User, world.actor_id)
        assert (user.updated_at, user.performed_by) == metadata
        assert (
            list(db.scalars(select(AuditLog.id).where(AuditLog.entity_id == world.actor_id)))
            == before_audits
        )


@pytest.mark.parametrize("failure", ["malformed", "unavailable", "mismatch"])
def test_failed_or_unbound_get_never_replaces_last_valid_observation(observation_world, failure):
    world = observation_world
    with Session(world.owner) as db:
        row = db.get(IdentityMfaObservation, world.actor_id)
        row.observed_provider_user_id, row.verified_totp, row.observed_at = (
            world.provider_id,
            True,
            world.clock,
        )
        db.commit()
    before = observed(world)

    def fail(request):
        if request.method != "GET" or not request.url.path.endswith(str(world.provider_id)):
            return None
        if failure == "unavailable":
            return httpx.Response(503)
        return httpx.Response(
            200,
            json={
                "id": str(uuid4() if failure == "mismatch" else world.provider_id),
                "email": world.email,
                "factors": [] if failure == "mismatch" else None,
            },
        )

    world.hook = fail
    response = world.client.get("/api/auth/mfa", headers=world.headers("aal2"))
    assert response.status_code in {401, 503}
    assert observed(world) == before


def test_ordinary_auth_is_read_only_and_refresh_does_not_first_insert_a_user_fk(observation_world):
    world = observation_world
    assert world.client.get("/api/auth/me", headers=world.headers()).status_code == 200
    assert observed(world) == (None, None, None)
    with Session(world.owner) as db:
        db.delete(db.get(IdentityMfaObservation, world.actor_id))
        db.commit()
    world.client.cookies.set("openslate_refresh", world.handles[0])
    world.client.cookies.set("openslate_csrf", world.csrf[0])
    response = world.client.post("/api/auth/refresh", headers={"X-CSRF-Token": world.csrf[0]})
    assert response.status_code == 200
    assert observed(world) is None
    with Session(world.owner) as db:
        user = db.get(User, world.actor_id)
        metadata = user.updated_at, user.performed_by
        audits = list(db.scalars(select(AuditLog.id).where(AuditLog.entity_id == world.actor_id)))
    world.login_slot = 4  # An owned provider session not already locally admitted.
    response = world.client.post(
        "/api/auth/login", json={"email": world.email, "password": world.password}
    )
    assert response.status_code == 200
    fact = observed(world)
    assert fact[0] == world.provider_id and fact[1] is False and fact[2] is not None
    with Session(world.owner) as db:
        user = db.get(User, world.actor_id)
        assert (user.updated_at, user.performed_by) == metadata
        assert (
            list(db.scalars(select(AuditLog.id).where(AuditLog.entity_id == world.actor_id)))
            == audits
        )


def test_delayed_complete_read_cannot_overwrite_newer_complete_observation(observation_world):
    world = observation_world
    world.factor_status = "verified"
    first_read, release = Event(), Event()
    handled = False

    def hold_first(request):
        nonlocal handled
        if request.method == "GET" and request.url.path == "/auth/v1/user" and not handled:
            handled = True
            payload = {
                "id": str(world.provider_id),
                "email": world.email,
                "factors": [
                    {"id": str(world.factor_id), "factor_type": "totp", "status": "verified"}
                ],
            }
            first_read.set()
            assert release.wait(5), "Second status read never completed"
            return httpx.Response(200, json=payload)
        return None

    world.hook = hold_first

    def read():
        with TestClient(
            world.client.app, base_url=get_settings().public_origin, raise_server_exceptions=False
        ) as client:
            return client.get("/api/auth/mfa", headers=world.headers("aal2"))

    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            old = pool.submit(read)
            assert first_read.wait(5), "First complete provider read did not begin"
            world.factor_status = None
            fresh = read()
            assert fresh.status_code == 200
            newer = observed(world)
            assert newer[1] is False and newer[2] is not None
            release.set()
            assert old.result(timeout=5).status_code == 200
        assert observed(world) == newer
    finally:
        release.set()


def test_rebinding_during_status_read_rejects_old_provider_facts(observation_world):
    world = observation_world

    def rebind(request):
        if request.method == "GET" and request.url.path == "/auth/v1/user":
            with Session(world.owner) as db:
                user = db.get(User, world.actor_id)
                user.supabase_user_id = uuid4()
                db.commit()
        return None

    world.hook = rebind
    assert world.client.get("/api/auth/mfa", headers=world.headers()).status_code == 401
    assert observed(world) == (None, None, None)


def test_enrollment_keeps_unverified_evidence_and_verification_records_complete_read(
    observation_world,
):
    world = observation_world

    def enroll(request):
        if request.method == "POST" and request.url.path == "/auth/v1/factors":
            world.factor_status = "unverified"
            return httpx.Response(
                200,
                json={
                    "id": str(world.factor_id),
                    "type": "totp",
                    "totp": {
                        "qr_code": "owned-test-qr",
                        "secret": "owned-test-secret",
                        "uri": "otpauth://totp/owned-test",
                    },
                },
            )
        return None

    world.hook = enroll
    response = world.client.post("/api/auth/mfa/factors", headers=world.headers(), json={})
    assert response.status_code == 201
    assert observed(world)[1] is False
    response = world.client.post(
        f"/api/auth/mfa/factors/{world.factor_id}/verification",
        headers=world.headers(),
        json={"code": "123456"},
    )
    assert response.status_code == 200
    assert observed(world)[1] is True


def test_verified_factor_removal_invalidates_aggregate_without_claiming_mfa_off(observation_world):
    world = observation_world
    world.factor_status = "verified"
    with Session(world.owner) as db:
        row = db.get(IdentityMfaObservation, world.actor_id)
        row.observed_provider_user_id, row.verified_totp, row.observed_at = (
            world.provider_id,
            True,
            world.clock - timedelta(minutes=1),
        )
        db.commit()
    response = world.client.delete(
        f"/api/auth/mfa/factors/{world.factor_id}", headers=world.headers("aal2")
    )
    assert response.status_code == 204
    fact = observed(world)
    assert fact[0] == world.provider_id and fact[1] is None and fact[2] >= world.clock
    assert all(session.revoked_at is not None for session in world.sessions())


@pytest.fixture
def provider_account():
    from tests.auth.test_provider_auth_integration import provider_account as original

    yield from original.__wrapped__()


@pytest.fixture
def security_world(provider_account, monkeypatch):
    from tests.access.test_user_security_http_integration import world as original

    yield from original.__wrapped__(provider_account, monkeypatch)


def test_admin_status_and_complete_reset_record_current_bound_observation(security_world):
    world = security_world
    with Session(world.owner) as db:
        db.add(IdentityMfaObservation(user_id=world.target_id))
        db.commit()
    response = world.client.get(
        f"/api/users/{world.target_id}/security", headers=world.headers("aal2")
    )
    assert response.status_code == 200
    with Session(world.owner) as db:
        row = db.get(IdentityMfaObservation, world.target_id)
        assert row.verified_totp is True and row.observed_at is not None
    response = world.client.post(
        f"/api/users/{world.target_id}/mfa/reset", headers=world.headers("aal2"), json={}
    )
    assert response.status_code == 200
    assert all(row.revoked_at is not None for row in world.sessions())
    with Session(world.owner) as db:
        row = db.get(IdentityMfaObservation, world.target_id)
        assert (
            row.verified_totp is False and row.observed_provider_user_id == world.target_provider_id
        )


def test_projection_fault_after_reset_cannot_prevent_captured_cleanup(security_world, monkeypatch):
    from sqlalchemy.exc import SQLAlchemyError

    world = security_world
    with Session(world.owner) as db:
        db.add(
            IdentityMfaObservation(
                user_id=world.target_id,
                observed_provider_user_id=world.target_provider_id,
                verified_totp=True,
                observed_at=world.clock
                if hasattr(world, "clock")
                else world.sessions()[0].created_at,
            )
        )
        db.commit()
    expected_factors = {factor["id"] for factor in world.factors}
    original = Session.commit

    def fail_projection(db):
        if any(isinstance(row, IdentityMfaObservation) for row in db.dirty):
            raise SQLAlchemyError("Owned projection persistence fault")
        return original(db)

    monkeypatch.setattr(Session, "commit", fail_projection)
    response = world.client.post(
        f"/api/users/{world.target_id}/mfa/reset", headers=world.headers("aal2"), json={}
    )
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail["local_revocation"] == "committed" and detail["factors_cleared"] is True
    assert all(row.revoked_at is not None for row in world.sessions())
    assert {
        path.rsplit("/", 1)[1] for method, path in world.calls if method == "DELETE"
    } == expected_factors
    assert not world.factors


def test_existing_refresh_observes_complete_user_without_changing_signin_ip(observation_world):
    from app.systems.access.identity.models import IdentitySession

    world = observation_world
    world.factor_status = "verified"
    with Session(world.owner) as db:
        session = db.get(IdentitySession, world.session_ids[0])
        session.ip_address = "2001:db8::44"
        db.commit()
    world.client.cookies.set("openslate_refresh", world.handles[0])
    world.client.cookies.set("openslate_csrf", world.csrf[0])
    response = world.client.post("/api/auth/refresh", headers={"X-CSRF-Token": world.csrf[0]})
    assert response.status_code == 200
    assert observed(world)[1] is True
    with Session(world.owner) as db:
        assert str(db.get(IdentitySession, world.session_ids[0]).ip_address) == "2001:db8::44"


def test_pending_profile_creation_initializes_unknown_even_when_provider_invitation_fails(
    observation_world,
):
    world = observation_world
    marker = uuid4().hex
    email = f"pending-observation-{marker}@example.test"
    try:
        response = world.client.post(
            "/api/auth/invitations",
            headers=world.headers("aal2"),
            json={"email": email, "username": f"pending_{marker}", "role": "member"},
        )
        # This route maps provider invitation failure to its existing safe 409.
        assert response.status_code == 409
        with Session(world.owner) as db:
            user = db.scalar(select(User).where(User.email == email))
            assert user is not None and user.status == "pending" and user.supabase_user_id is None
            row = db.get(IdentityMfaObservation, user.id)
            fact = (
                None
                if row is None
                else (row.observed_provider_user_id, row.verified_totp, row.observed_at)
            )
        assert fact == (None, None, None)
    finally:
        with Session(world.owner) as db:
            user = db.scalar(select(User).where(User.email == email))
            if user is not None:
                db.delete(user)
                db.commit()


def test_completed_factor_removal_outranks_a_complete_read_started_during_the_effect(
    observation_world,
):
    world = observation_world
    world.factor_status = "verified"
    deleting, release = Event(), Event()

    def hold_delete(request):
        if request.method == "DELETE" and request.url.path.endswith(str(world.factor_id)):
            deleting.set()
            assert release.wait(5), "Concurrent complete read did not finish"
        return None

    world.hook = hold_delete

    def remove():
        with TestClient(
            world.client.app,
            base_url=get_settings().public_origin,
            raise_server_exceptions=False,
        ) as client:
            return client.delete(
                f"/api/auth/mfa/factors/{world.factor_id}", headers=world.headers("aal2")
            )

    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            removal = pool.submit(remove)
            assert deleting.wait(5), "Actual provider factor deletion did not begin"
            response = world.client.get("/api/auth/mfa", headers=world.headers("aal2"))
            assert response.status_code == 200
            during_effect = observed(world)
            assert during_effect[1] is True
            release.set()
            assert removal.result(timeout=5).status_code == 204
        final = observed(world)
        assert final[0] == world.provider_id and final[1] is None
        assert final[2] > during_effect[2]
        assert all(session.revoked_at is not None for session in world.sessions())
    finally:
        release.set()
