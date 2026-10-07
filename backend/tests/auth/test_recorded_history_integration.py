"""Durable recorded User history at real signed-HTTP/committed PostgreSQL boundaries."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event, local

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database.session import AuditSession, get_engine
from app.systems.access.identity.models import IdentityMfaObservation, IdentitySession
from app.systems.access.users.models import User
from app.systems.manage.audit.models import AuditLog

pytest_plugins = ("tests.auth.session_policy_support",)
pytestmark = pytest.mark.integration


def _history(world):
    with Session(world.owner) as db:
        row = db.get(IdentityMfaObservation, world.actor_id)
        return None if row is None else (row.last_sign_in_at, row.last_active_at)


def _seed(world):
    with Session(world.owner) as db:
        row = db.get(IdentityMfaObservation, world.actor_id)
        row.last_sign_in_at = world.clock - timedelta(days=2)
        row.last_active_at = world.clock - timedelta(days=1)
        user = db.get(User, world.actor_id)
        profile = user.updated_at, user.performed_by
        audits = list(db.scalars(select(AuditLog.id).where(AuditLog.entity_id == user.id)))
        db.commit()
    return _history(world), profile, audits


def _act(world, kind):
    if kind == "admission":
        world.login_slot = 4
        return world.client.post(
            "/api/auth/login", json={"email": world.email, "password": world.password}
        )
    if kind == "verification":
        world.factor_status = "unverified"
        return world.client.post(
            f"/api/auth/mfa/factors/{world.factor_id}/verification",
            headers=world.headers(),
            json={"code": "123456"},
        )
    if kind == "rotated":
        cipher = Fernet(get_settings().supabase_session_encryption_key.get_secret_value().encode())
        with Session(world.owner) as db:
            row = db.get(IdentitySession, world.session_ids[0])
            expired = world.access(exp=int(world.clock.timestamp()) - 60)
            row.provider_access_token_encrypted = cipher.encrypt(expired.encode()).decode()
            db.commit()
    world.client.cookies.set("openslate_refresh", world.handles[0])
    world.client.cookies.set("openslate_csrf", world.csrf[0])
    return world.client.post("/api/auth/refresh", headers={"X-CSRF-Token": world.csrf[0]})


@pytest.mark.parametrize("kind", ["admission", "cached", "rotated", "verification"])
def test_only_committed_admission_signs_in_and_successful_renewals_record_activity(
    policy_world, kind
):
    world = policy_world
    before, profile, audits = _seed(world)
    result = _act(world, kind)
    assert result.status_code == 200
    sign_in, active = _history(world)
    assert active == world.clock
    assert sign_in == (world.clock if kind == "admission" else before[0])
    with Session(world.owner) as db:
        user = db.get(User, world.actor_id)
        assert (user.updated_at, user.performed_by) == profile
        assert list(db.scalars(select(AuditLog.id).where(AuditLog.entity_id == user.id))) == audits


@pytest.mark.parametrize("kind", ["admission", "cached", "rotated", "verification"])
def test_history_write_and_auth_result_roll_back_together_on_commit_failure(
    policy_world, monkeypatch, kind
):
    world = policy_world
    before, _, _ = _seed(world)
    original, original_flush = AuditSession.commit, AuditSession.flush
    injected = False

    def captures_history(db):
        return any(
            isinstance(row, IdentityMfaObservation)
            and row.user_id == world.actor_id
            and row.last_active_at == world.clock
            for row in (*db.new, *db.dirty)
        )

    def remember_flush(db, *args, **kwargs):
        if captures_history(db):
            db.info["owned_history_flushed"] = True
        return original_flush(db, *args, **kwargs)

    def fail_recorded_commit(db):
        nonlocal injected
        if not injected and (captures_history(db) or db.info.get("owned_history_flushed")):
            injected = True
            raise SQLAlchemyError("Owned recorded-history commit failure")
        return original(db)

    monkeypatch.setattr(AuditSession, "flush", remember_flush)
    monkeypatch.setattr(AuditSession, "commit", fail_recorded_commit)
    result = _act(world, kind)
    assert injected and result.status_code == 503
    assert _history(world) == before


@pytest.mark.parametrize(
    "action", ["status", "policy", "enrollment", "removal", "revocation", "failure"]
)
def test_reads_enrollment_revocation_and_failed_verification_never_advance_history(
    policy_world, action
):
    world = policy_world
    before, _, _ = _seed(world)
    if action == "status":
        result = world.client.get("/api/auth/mfa", headers=world.headers())
        expected = 200
    elif action == "policy":
        result = world.client.get("/api/workspace/security", headers=world.headers())
        expected = 200
    elif action == "enrollment":
        import httpx

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
        result = world.client.post("/api/auth/mfa/factors", headers=world.headers(), json={})
        expected = 201
    elif action == "removal":
        world.factor_status = "verified"
        result = world.client.delete(
            f"/api/auth/mfa/factors/{world.factor_id}", headers=world.headers("aal2")
        )
        expected = 204
    elif action == "revocation":
        result = world.client.delete(
            f"/api/users/{world.actor_id}/sessions/{world.session_ids[1]}", headers=world.headers()
        )
        expected = 204
    else:
        world.factor_status = "unverified"
        import httpx

        world.hook = lambda request: (
            httpx.Response(400) if request.url.path.endswith("/verify") else None
        )
        result = _act(world, "verification")
        expected = 400
    assert result.status_code == expected
    assert _history(world) == before


@pytest.mark.parametrize(
    "failure", ["expired", "revoked", "csrf", "provider", "binding", "password"]
)
def test_failed_admission_or_refresh_preserves_recorded_history(policy_world, failure):
    from uuid import uuid4

    import httpx

    world = policy_world
    history, _, _ = _seed(world)
    if failure in {"expired", "revoked", "binding"}:
        with Session(world.owner) as db:
            if failure == "binding":
                db.get(User, world.actor_id).supabase_user_id = uuid4()
            else:
                row = db.get(IdentitySession, world.session_ids[0])
                if failure == "expired":
                    row.expires_at = world.clock
                else:
                    row.revoked_at = world.clock
            db.commit()
    elif failure == "provider":
        world.hook = lambda request: (
            httpx.Response(503) if request.url.path.endswith(str(world.provider_id)) else None
        )
    elif failure == "password":
        world.hook = lambda request: (
            httpx.Response(400) if request.url.path == "/auth/v1/token" else None
        )
    if failure == "csrf":
        world.client.cookies.set("openslate_refresh", world.handles[0])
        world.client.cookies.set("openslate_csrf", world.csrf[0])
        response = world.client.post("/api/auth/refresh", headers={"X-CSRF-Token": "wrong"})
        expected = 401
    else:
        response = _act(world, "admission" if failure == "password" else "cached")
        expected = 503 if failure == "provider" else 401
    assert response.status_code == expected
    assert _history(world) == history


def test_stale_mfa_evidence_does_not_suppress_accepted_cached_activity(policy_world):
    world = policy_world
    before, _, _ = _seed(world)
    with Session(world.owner) as db:
        row = db.get(IdentityMfaObservation, world.actor_id)
        row.observed_provider_user_id, row.verified_totp = world.provider_id, True
        row.observed_at = world.clock + timedelta(minutes=1)
        fence = row.observed_at
        db.commit()
    response = _act(world, "cached")
    assert response.status_code == 200
    assert _history(world) == (before[0], world.clock)
    with Session(world.owner) as db:
        row = db.get(IdentityMfaObservation, world.actor_id)
        assert row.verified_totp is True and row.observed_at == fence


def test_refresh_never_first_inserts_history_but_safe_new_admission_reconstructs_it(policy_world):
    world = policy_world
    with Session(world.owner) as db:
        db.delete(db.get(IdentityMfaObservation, world.actor_id))
        db.commit()
    response = _act(world, "cached")
    assert response.status_code == 200 and _history(world) is None
    response = _act(world, "admission")
    assert response.status_code == 200
    assert _history(world) == (world.clock, world.clock)


def test_concurrent_older_refresh_cannot_erase_newer_committed_activity(policy_world, monkeypatch):
    from app.systems.access.identity import provider_sessions

    world = policy_world
    before, _, _ = _seed(world)
    clock = local()
    monkeypatch.setattr(
        provider_sessions, "utc_now", lambda: getattr(clock, "instant", world.clock)
    )
    entered, release = Event(), Event()
    older_time, newer_time = world.clock, world.clock + timedelta(seconds=10)
    original_resolve = provider_sessions._resolved_provider_session

    def establish_request_clock(db, claims, client, **kwargs):
        # TestClient dispatches sync routes onto its own worker thread. Set the
        # owned clock at the real resolver boundary in that same thread.
        clock.older = claims.session_id == world.provider_sessions[0]
        clock.instant = older_time if clock.older else newer_time
        return original_resolve(db, claims, client, **kwargs)

    monkeypatch.setattr(provider_sessions, "_resolved_provider_session", establish_request_clock)

    def hold_older(request):
        if getattr(clock, "older", False) and request.url.path.endswith(str(world.provider_id)):
            entered.set()
            assert release.wait(10), "Newer independent refresh did not complete"
        return None

    world.hook = hold_older

    def renew(slot):
        with TestClient(
            world.client.app, base_url=get_settings().public_origin, raise_server_exceptions=False
        ) as client:
            client.headers["Origin"] = get_settings().public_origin
            client.cookies.set("openslate_refresh", world.handles[slot])
            client.cookies.set("openslate_csrf", world.csrf[slot])
            return client.post(
                "/api/auth/refresh", headers={"X-CSRF-Token": world.csrf[slot]}
            ).status_code

    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(renew, 0)
            assert entered.wait(10), "Older refresh never reached the real provider-read boundary"
            assert renew(1) == 200
            assert _history(world) == (before[0], newer_time)
            release.set()
            assert pending.result(timeout=10) == 200
        assert _history(world) == (before[0], newer_time)
    finally:
        release.set()


def test_user_history_survives_binding_observations_and_terminal_session_deletion(
    policy_world, monkeypatch
):
    from uuid import uuid4

    from app.systems.access.identity import session_retention
    from app.systems.access.identity.mfa_observations import record_observation
    from app.systems.manage.audit.models import SecurityEvent

    world = policy_world
    before, _, _ = _seed(world)
    replacement = uuid4()
    with Session(world.owner) as db:
        user = db.get(User, world.actor_id)
        user.supabase_user_id = replacement
        db.commit()
        record_observation(
            db, world.actor_id, replacement, False, world.clock + timedelta(seconds=1)
        )
        db.commit()
        for row in db.scalars(
            select(IdentitySession).where(IdentitySession.user_id == world.actor_id)
        ):
            row.expires_at = row.revoked_at = world.clock - timedelta(days=400)
            row.provider_signout_pending_at = row.provider_signout_next_attempt_at = None
            row.provider_signout_attempts = 0
        db.commit()
    assert _history(world) == before
    proof_ids = []
    original_append = session_retention.append_security_event

    def capture_owned_proof(db, payload):
        event = original_append(db, payload)
        proof_ids.append(event.id)
        return event

    monkeypatch.setattr(session_retention, "append_security_event", capture_owned_proof)
    try:
        with AuditSession(get_engine()) as db:
            assert session_retention.retain_terminal_sessions(db) >= len(world.session_ids)
        with Session(world.owner) as db:
            assert not list(
                db.scalars(
                    select(IdentitySession.id).where(IdentitySession.user_id == world.actor_id)
                )
            )
        assert _history(world) == before
    finally:
        with Session(world.owner) as db:
            for event in db.scalars(select(SecurityEvent).where(SecurityEvent.id.in_(proof_ids))):
                db.delete(event)
            db.commit()
