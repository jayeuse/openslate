"""Actual authentication admissions and durable login budgets with private provider fakes."""

import json
from ipaddress import ip_address
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    SupabaseAuthUnavailable,
    get_supabase_auth_client,
)
from app.systems.access.identity import rate_limits
from app.systems.access.identity.models import IdentityRateLimitBucket, IdentitySession

pytest_plugins = ("tests.security_events.event_support",)
pytestmark = pytest.mark.integration


def source():
    return str(ip_address(f"2001:db8:{uuid4().hex[:4]}:{uuid4().hex[:4]}::1"))


def test_failed_browser_and_bearer_credentials_share_an_anonymous_source_hour(
    event_world, monkeypatch
):
    world = event_world
    address = source()
    provider = get_supabase_auth_client()

    def wrong(*args):
        raise InvalidProviderCredentials("private upstream credential detail")

    monkeypatch.setattr(provider, "password_grant", wrong)
    with world.anonymous(address) as client:
        for path, email in [
            ("/api/auth/login", "one@example.test"),
            ("/api/auth/token", "two@example.test"),
        ]:
            response = client.post(path, json={"email": email, "password": "private-wrong"})
            assert response.status_code == 401
    rows = [
        r
        for r in world.records("identity.sign_in_failure")
        if r.event_metadata.get("ip_address") == address
    ]
    assert len(rows) == 1
    row = rows[0]
    assert row.actor_id is None and row.subject_id is None and row.outcome == "failure"
    assert row.event_metadata["bucket_start"] < row.event_metadata["bucket_end"]
    recorded = json.dumps(
        {"labels": row.labels, "metadata": row.event_metadata, "reason": row.reason}
    )
    assert all(
        secret not in recorded
        for secret in ["one@example.test", "two@example.test", "private-wrong", "private upstream"]
    )
    assert "count" not in row.event_metadata and "last_seen" not in row.event_metadata


def test_each_committed_sign_in_has_its_bound_local_person(event_world):
    world = event_world
    before = {r.id for r in world.records("identity.sign_in", actor_id=world.actor_id)}
    address = source()
    with world.anonymous(address) as client:
        client.headers["X-Forwarded-For"] = "203.0.113.199"
        for path in ["/api/auth/login", "/api/auth/token"]:
            client.cookies.clear()
            response = client.post(path, json={"email": world.email, "password": world.password})
            assert response.status_code == 200
    rows = [
        r for r in world.records("identity.sign_in", actor_id=world.actor_id) if r.id not in before
    ]
    assert len(rows) == 2 and len({r.operation_id for r in rows}) == 2
    assert all(r.subject_id == world.actor_id and r.outcome == "success" for r in rows)
    assert all(r.event_metadata.get("ip_address") == address for r in rows)


def test_new_lockout_is_atomic_and_already_blocked_retry_adds_no_transition(
    event_world, monkeypatch
):
    world = event_world
    address = source()
    world.policy(login_failed_attempt_threshold=1)
    provider = get_supabase_auth_client()
    calls = []

    def wrong(*args):
        calls.append(True)
        raise InvalidProviderCredentials("not recorded")

    monkeypatch.setattr(provider, "password_grant", wrong)
    with world.anonymous(address) as client:
        response = client.post("/api/auth/token", json={"email": world.email, "password": "wrong"})
        assert response.status_code == 401
        with Session(world.owner) as db:
            bucket = db.get(
                IdentityRateLimitBucket, rate_limits.login_fingerprint(world.email, address)
            )
            assert bucket is not None and bucket.blocked_until is not None
        rows = [
            r
            for r in world.records("identity.lockout")
            if r.event_metadata.get("ip_address") == address
        ]
        assert len(rows) == 1 and rows[0].outcome == "denied"
        assert rows[0].actor_id is None and rows[0].subject_id is None
        blocked = client.post("/api/auth/token", json={"email": world.email, "password": "wrong"})
        assert blocked.status_code == 429 and int(blocked.headers["retry-after"]) > 0
    assert len(calls) == 1
    assert [
        r.id
        for r in world.records("identity.lockout")
        if r.event_metadata.get("ip_address") == address
    ] == [rows[0].id]


def test_provider_availability_and_commit_failure_do_not_claim_sign_in(event_world, monkeypatch):
    world = event_world
    provider = get_supabase_auth_client()
    before = {r.id for r in world.records("identity.sign_in", actor_id=world.actor_id)}

    def unavailable(*args):
        raise SupabaseAuthUnavailable("private outage")

    monkeypatch.setattr(provider, "password_grant", unavailable)
    address = source()
    with world.anonymous(address) as client:
        response = client.post(
            "/api/auth/token", json={"email": world.email, "password": world.password}
        )
        assert response.status_code == 503
    assert not [
        r
        for r in world.records("identity.sign_in_failure")
        if r.event_metadata.get("ip_address") == address
    ]
    assert {r.id for r in world.records("identity.sign_in", actor_id=world.actor_id)} == before


def test_ip_denials_are_separate_source_hour_rows_with_only_verified_attribution(
    event_world, monkeypatch
):
    world = event_world
    world.policy(ip_allow_list=["127.0.0.1/32"])
    anonymous_address, verified_address = source(), source()
    provider = get_supabase_auth_client()
    calls = []
    original = provider.password_grant

    def grant(*args):
        calls.append(True)
        return original(*args)

    monkeypatch.setattr(provider, "password_grant", grant)
    with world.anonymous(anonymous_address) as client:
        for forwarded in ["192.0.2.1", "192.0.2.2"]:
            response = client.post(
                "/api/auth/login",
                headers={"X-Forwarded-For": forwarded},
                json={"email": "unknown@example.test", "password": "not-recorded"},
            )
            assert (
                response.status_code == 403
                and response.json()["detail"]["code"] == "ip_not_allowed"
            )
    assert not calls
    with world.anonymous(verified_address) as client:
        client.cookies.update(world.client.cookies)
        result = client.get("/api/auth/me")
        assert result.status_code == 403
    rows = [
        r
        for r in world.records("identity.ip_blocked")
        if r.event_metadata.get("ip_address") in [anonymous_address, verified_address]
    ]
    assert len(rows) == 2
    anonymous = next(r for r in rows if r.event_metadata["ip_address"] == anonymous_address)
    verified = next(r for r in rows if r.event_metadata["ip_address"] == verified_address)
    assert anonymous.actor_id is None and anonymous.subject_id is None
    assert verified.actor_id == world.actor_id and verified.subject_id == world.actor_id
    assert all(r.outcome == "denied" for r in rows)
    assert not [
        r
        for r in world.records("identity.sign_in_failure")
        if r.event_metadata.get("ip_address") in [anonymous_address, verified_address]
    ]


def test_lowered_login_threshold_commits_one_lockout_but_recovery_budget_does_not(event_world):
    world = event_world
    address = source()
    timestamp = world.clock
    world.policy(login_failed_attempt_threshold=1)
    fingerprint = rate_limits.login_fingerprint("not-recorded@example.test", address)
    with Session(world.owner) as db:
        db.add(
            IdentityRateLimitBucket(
                fingerprint=fingerprint,
                attempt_count=2,
                window_started_at=timestamp,
                blocked_until=None,
            )
        )
        db.commit()
    with world.anonymous(address) as client:
        result = client.post(
            "/api/auth/token", json={"email": "not-recorded@example.test", "password": "wrong"}
        )
        assert result.status_code == 429 and int(result.headers["retry-after"]) > 0
    rows = [
        r
        for r in world.records("identity.lockout")
        if r.event_metadata.get("ip_address") == address
    ]
    assert len(rows) == 1
    with Session(world.owner) as db:
        assert db.get(IdentityRateLimitBucket, fingerprint).blocked_until is not None
    before = {r.id for r in world.records("identity.lockout")}
    with Session(world.owner) as db:
        for _ in range(5):
            rate_limits.recovery_request_permitted(
                db, "anonymous@example.test", source=source(), now_value=timestamp
            )
            rate_limits.invitation_completion_permitted(db, source=address, now_value=timestamp)
        db.commit()
    assert {r.id for r in world.records("identity.lockout")} == before


@pytest.mark.parametrize("denied", [True, False])
def test_login_commit_failure_is_safe_and_cannot_persist_an_admission_or_failure(
    event_world, monkeypatch, denied
):
    from sqlalchemy.exc import SQLAlchemyError

    from app.core.database.session import AuditSession

    world = event_world
    address = source()
    before_signin = {r.id for r in world.records("identity.sign_in", actor_id=world.actor_id)}
    with Session(world.owner) as db:
        before_sessions = set(
            db.scalars(select(IdentitySession.id).where(IdentitySession.user_id == world.actor_id))
        )
    if denied:

        def wrong(*args):
            raise InvalidProviderCredentials("not recorded")

        monkeypatch.setattr(get_supabase_auth_client(), "password_grant", wrong)
    original = AuditSession.commit

    def failed(db):
        raise SQLAlchemyError("private commit failure")

    monkeypatch.setattr(AuditSession, "commit", failed)
    with world.anonymous(address) as client:
        result = client.post(
            "/api/auth/token", json={"email": world.email, "password": world.password}
        )
    monkeypatch.setattr(AuditSession, "commit", original)
    assert result.status_code == 503
    assert {
        r.id for r in world.records("identity.sign_in", actor_id=world.actor_id)
    } == before_signin
    assert not [
        r
        for r in world.records("identity.sign_in_failure")
        if r.event_metadata.get("ip_address") == address
    ]
    with Session(world.owner) as db:
        assert (
            set(
                db.scalars(
                    select(IdentitySession.id).where(IdentitySession.user_id == world.actor_id)
                )
            )
            == before_sessions
        )


@pytest.mark.parametrize("kind", ["password_change", "elevated_password"])
def test_authenticated_password_budget_and_step_up_emit_lockout_but_never_sign_in(
    event_world, monkeypatch, kind
):
    from app.core.database.session import AuditSession, get_engine
    from app.systems.sandbox.lifecycle.exceptions import (
        LifecycleInvalidCredentials,
        LifecyclePasswordRateLimited,
    )
    from app.systems.sandbox.lifecycle.password import ProviderPasswordGrantClient

    world = event_world
    world.policy(login_failed_attempt_threshold=1)
    before = {r.id for r in world.records("identity.lockout")}
    before_signin = {r.id for r in world.records("identity.sign_in")}
    before_failures = {r.id for r in world.records("identity.sign_in_failure")}
    calls = []

    def wrong(*args):
        calls.append(True)
        raise InvalidProviderCredentials("private credential detail")

    provider = get_supabase_auth_client()
    monkeypatch.setattr(provider, "password_grant", wrong)
    if kind == "password_change":
        payload = {
            "current_password": "wrong",
            "password": "A uniquely secure candidate phrase 927!",
        }
        assert world.client.post("/api/auth/password/change", json=payload).status_code == 403
        assert world.client.post("/api/auth/password/change", json=payload).status_code == 429
    else:
        with AuditSession(bind=get_engine()) as db:
            verifier = ProviderPasswordGrantClient(db, client=provider)
            with pytest.raises(LifecycleInvalidCredentials):
                verifier.verify_password(world.email, "wrong")
            with pytest.raises(LifecyclePasswordRateLimited):
                verifier.verify_password(world.email, "wrong")
    assert calls == [True]
    rows = [r for r in world.records("identity.lockout") if r.id not in before]
    assert len(rows) == 1
    assert rows[0].actor_id == (world.actor_id if kind == "password_change" else None)
    assert {r.id for r in world.records("identity.sign_in")} == before_signin
    assert {r.id for r in world.records("identity.sign_in_failure")} == before_failures
