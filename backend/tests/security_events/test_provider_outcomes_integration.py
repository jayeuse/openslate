"""Truthful event phases across real local commit and controlled provider outcomes."""

import json
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.database.session import AuditSession
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    ProviderTokens,
    SupabaseAuthUnavailable,
    get_supabase_auth_client,
)
from app.systems.access.identity.models import IdentitySession
from app.systems.manage.audit import service as audit_service

pytest_plugins = ("tests.security_events.event_support",)
pytestmark = pytest.mark.integration


def request_client(world, address=None):
    return world.anonymous(
        address or f"2001:db8:{int(uuid4().hex[:4], 16):x}:{int(uuid4().hex[:4], 16):x}::1"
    )


def test_recovery_request_parity_records_accepted_not_delivery_and_suppression(
    event_world, monkeypatch
):
    world = event_world
    provider = get_supabase_auth_client()
    calls = []
    monkeypatch.setattr(provider, "request_recovery", lambda email: calls.append(email))
    before = {r.id for r in world.records("identity.recovery_request")}
    unknown = f"unknown-{uuid4()}@example.test"
    address = f"2001:db8:{int(uuid4().hex[:4], 16):x}:{int(uuid4().hex[:4], 16):x}::1"
    with request_client(world, address) as client:
        client.headers["X-Forwarded-For"] = "203.0.113.199"
        for email in [world.email, unknown]:
            response = client.post("/api/auth/recovery/request", json={"email": email})
            assert response.status_code == 204 and response.content == b""
    rows = [r for r in world.records("identity.recovery_request") if r.id not in before]
    assert len(rows) == 4
    assert sorted(r.outcome for r in rows) == ["attempt", "attempt", "success", "success"]
    assert len({r.operation_id for r in rows}) == 2
    assert all(r.actor_id is None and r.subject_id is None for r in rows)
    assert all(r.event_metadata.get("ip_address") == address for r in rows)
    assert calls == [world.email, unknown]
    recorded = json.dumps(
        [{"labels": r.labels, "metadata": r.event_metadata, "reason": r.reason} for r in rows]
    )
    assert world.email not in recorded and unknown not in recorded and "delivered" not in recorded
    # Complete the known-recipient budget; suppressed requests still return generic204.
    with request_client(world) as client:
        for _ in range(5):
            assert (
                client.post("/api/auth/recovery/request", json={"email": world.email}).status_code
                == 204
            )
    assert len(calls) == 6  # first known + unknown + four remaining admitted known requests
    assert (
        len(
            [
                r
                for r in world.records("identity.recovery_request")
                if r.id not in before and r.outcome == "success"
            ]
        )
        == 6
    )


def test_event_store_refusal_prevents_recovery_provider_effect(event_world, monkeypatch):
    provider = get_supabase_auth_client()
    calls = []
    monkeypatch.setattr(provider, "request_recovery", lambda email: calls.append(True))

    def unavailable(payload):
        raise audit_service.SecurityEventPersistenceError("private storage failure")

    monkeypatch.setattr(audit_service, "append_committed_security_event", unavailable)
    with request_client(event_world) as client:
        response = client.post("/api/auth/recovery/request", json={"email": event_world.email})
    assert response.status_code == 503 and not calls
    assert "private storage failure" not in response.text


def prepare_action(world, monkeypatch, kind, fault):
    provider = get_supabase_auth_client()
    observed = provider.get_admin_user(world.provider_id)
    temporary = ProviderTokens(
        "owned-temporary-access", "owned-temporary-refresh", world.provider_id, 600
    )
    original_get = provider.get_user
    monkeypatch.setattr(provider, "password_grant", lambda *args: temporary)
    monkeypatch.setattr(provider, "verify_email_action", lambda *args: temporary)
    monkeypatch.setattr(
        provider,
        "get_user",
        lambda value: observed if value == temporary.access_token else original_get(value),
    )
    monkeypatch.setattr(provider, "sign_out", lambda *args, **kwargs: None)
    effects = []

    def update(*args):
        effects.append(True)
        if fault == "timeout":
            raise SupabaseAuthUnavailable("private timeout")
        if fault == "refused":
            raise InvalidProviderCredentials("private provider refusal")
        return observed

    monkeypatch.setattr(provider, "update_password", update)
    if fault == "commit":
        original_commit = AuditSession.commit
        failed = []

        def commit(db):
            if (
                effects
                and not failed
                and any(
                    isinstance(row, IdentitySession) and row.revoked_at is not None
                    for row in db.dirty
                )
            ):
                failed.append(True)
                raise SQLAlchemyError("private local commit failure")
            return original_commit(db)

        monkeypatch.setattr(AuditSession, "commit", commit)
    return effects


@pytest.mark.parametrize("kind", ["password_change", "recovery_complete"])
@pytest.mark.parametrize("fault", ["none", "timeout", "refused", "commit"])
def test_password_actions_correlate_attempt_with_truthful_terminal_and_local_state(
    event_world, monkeypatch, kind, fault
):
    world = event_world
    if kind == "password_change":
        # One independently admitted extra session gives the revocation commit an observable effect.
        with request_client(world) as client:
            assert (
                client.post(
                    "/api/auth/login", json={"email": world.email, "password": world.password}
                ).status_code
                == 200
            )
    with Session(world.owner) as db:
        before_sessions = {
            row.id: row.revoked_at
            for row in db.scalars(
                select(IdentitySession).where(IdentitySession.user_id == world.actor_id)
            )
        }
    world.client.headers["X-Forwarded-For"] = "203.0.113.199"
    before = {r.id for r in world.records(f"identity.{kind}")}
    effects = prepare_action(world, monkeypatch, kind, fault)
    if kind == "password_change":
        response = world.client.post(
            "/api/auth/password/change",
            json={
                "current_password": world.password,
                "password": "A uniquely secure candidate phrase 927!",
            },
        )
    else:
        response = world.client.post(
            "/api/auth/recovery/complete",
            json={"token_hash": "c" * 56, "password": "A uniquely secure candidate phrase 927!"},
        )
    expected = {
        "none": 200 if kind == "password_change" else 204,
        "timeout": 503,
        "refused": 403 if kind == "password_change" else 400,
        "commit": 503,
    }
    assert response.status_code == expected[fault]
    rows = [r for r in world.records(f"identity.{kind}") if r.id not in before]
    terminal = "success" if fault == "none" else "failure" if fault == "refused" else "partial"
    assert [r.outcome for r in rows] == ["attempt", terminal]
    assert len({r.operation_id for r in rows}) == 1
    assert all(r.actor_id == world.actor_id and r.subject_id == world.actor_id for r in rows)
    assert all(r.event_metadata.get("ip_address") == "127.0.0.1" for r in rows)
    assert effects == [True]
    recorded = json.dumps(
        [{"labels": r.labels, "metadata": r.event_metadata, "reason": r.reason} for r in rows]
    )
    assert all(
        secret not in recorded
        for secret in [world.email, world.password, "c" * 56, "owned-temporary", "private"]
    )
    with Session(world.owner) as db:
        after = {
            row.id: row.revoked_at
            for row in db.scalars(
                select(IdentitySession).where(IdentitySession.user_id == world.actor_id)
            )
        }
    if fault == "none":
        assert sum(value is not None for value in after.values()) == (
            len(after) if kind == "recovery_complete" else len(after) - 1
        )
    else:
        assert after == before_sessions


@pytest.mark.parametrize("kind", ["password_change", "recovery_complete"])
def test_password_action_attempt_store_failure_cannot_claim_a_possible_provider_effect(
    event_world, monkeypatch, kind
):
    world = event_world
    before = {r.id for r in world.records(f"identity.{kind}")}
    effects = prepare_action(world, monkeypatch, kind, "none")
    original = audit_service.append_committed_security_event

    def refuse_attempt(payload):
        if payload.outcome == "attempt":
            raise audit_service.SecurityEventPersistenceError("private logging failure")
        return original(payload)

    monkeypatch.setattr(audit_service, "append_committed_security_event", refuse_attempt)
    if kind == "password_change":
        result = world.client.post(
            "/api/auth/password/change",
            json={
                "current_password": world.password,
                "password": "A uniquely secure candidate phrase 927!",
            },
        )
    else:
        result = world.client.post(
            "/api/auth/recovery/complete",
            json={"token_hash": "c" * 56, "password": "A uniquely secure candidate phrase 927!"},
        )
    assert result.status_code == 503 and effects == []
    assert {r.id for r in world.records(f"identity.{kind}")} == before


def test_accepted_recovery_with_terminal_event_store_failure_is_partial_without_resend(
    event_world, monkeypatch
):
    world = event_world
    before = {r.id for r in world.records("identity.recovery_request")}
    calls = []
    monkeypatch.setattr(
        get_supabase_auth_client(), "request_recovery", lambda email: calls.append(True)
    )
    original = audit_service.append_committed_security_event

    def fail_terminal(payload):
        if payload.outcome == "success":
            raise audit_service.SecurityEventPersistenceError("private terminal event failure")
        return original(payload)

    monkeypatch.setattr(audit_service, "append_committed_security_event", fail_terminal)
    with request_client(world) as client:
        response = client.post("/api/auth/recovery/request", json={"email": world.email})
    assert response.status_code == 503 and calls == [True]
    rows = [r for r in world.records("identity.recovery_request") if r.id not in before]
    assert [r.outcome for r in rows] == ["attempt", "partial"]
    assert len({r.operation_id for r in rows}) == 1
    assert rows[1].event_metadata["stage"] == "event_commit"


def test_missing_transport_is_explicitly_unknown_across_admitted_action_and_policy_events(
    event_world, monkeypatch
):
    world = event_world
    kinds = [
        "identity.sign_in",
        "identity.recovery_request",
        "identity.password_change",
        "identity.recovery_complete",
        "workspace.security_policy_change",
    ]
    before = {kind: {r.id for r in world.records(kind)} for kind in kinds}
    monkeypatch.setattr(get_supabase_auth_client(), "request_recovery", lambda email: None)
    with world.anonymous(None) as client:
        client.headers["X-Forwarded-For"] = "203.0.113.199"
        assert (
            client.post(
                "/api/auth/login", json={"email": world.email, "password": world.password}
            ).status_code
            == 200
        )
        client.headers["X-CSRF-Token"] = client.cookies.get("openslate_csrf")
        assert (
            client.post("/api/auth/recovery/request", json={"email": world.email}).status_code
            == 204
        )
        revision = client.get("/api/workspace/security").json()["revision"]
        assert (
            client.patch(
                "/api/workspace/security",
                json={"revision": revision, "session_timeout_minutes": 30},
            ).status_code
            == 200
        )
        prepare_action(world, monkeypatch, "password_change", "none")
        assert (
            client.post(
                "/api/auth/password/change",
                json={
                    "current_password": world.password,
                    "password": "A uniquely secure candidate phrase 927!",
                },
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/auth/recovery/complete",
                json={
                    "token_hash": "c" * 56,
                    "password": "A uniquely secure candidate phrase 927!",
                },
            ).status_code
            == 204
        )
    for kind in kinds:
        rows = [r for r in world.records(kind) if r.id not in before[kind]]
        assert rows
        assert all(
            "ip_address" in r.event_metadata and r.event_metadata["ip_address"] is None
            for r in rows
        )
