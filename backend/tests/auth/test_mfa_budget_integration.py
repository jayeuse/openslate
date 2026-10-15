"""MFA admission budgets through signed routes and committed PostgreSQL state."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database.session import AuditSession
from app.systems.access.identity.models import IdentityRateLimitBucket
from app.systems.access.identity.rate_limits import rate_limit_fingerprint
from app.systems.manage.audit.models import SecurityEvent

pytest_plugins = ("tests.auth.session_policy_support",)
pytestmark = pytest.mark.integration


@pytest.fixture
def budget_world(policy_world):
    world = policy_world
    world.factor_status = "verified"
    access = world.access
    world.access = lambda *args, **kwargs: access(
        *args, exp=world.clock + timedelta(hours=1), **kwargs
    )
    world.bucket_ids.append(rate_limit_fingerprint("mfa-account", str(world.actor_id), None))
    callers = []

    def caller(source="198.51.100.21"):
        world.bucket_ids.append(rate_limit_fingerprint("mfa-source", source, None))
        client = TestClient(
            world.client.app, base_url=get_settings().public_origin, client=(source, 50000)
        )
        callers.append(client)
        return client

    def denied_code(request):
        if request.url.path.endswith("/verify"):
            return httpx.Response(400, json={"msg": "Code not accepted"})
        return None

    world.hook = denied_code
    world.caller = caller
    world.path = f"/api/auth/mfa/factors/{world.factor_id}/verification"
    world.account_fingerprint = world.bucket_ids[0]
    try:
        yield world
    finally:
        for client in callers:
            client.close()


def verify(world, caller, slot=0):
    return caller.post(world.path, headers=world.headers(slot=slot), json={"code": "123456"})


def budget(world, fingerprint):
    with Session(world.owner) as db:
        row = db.get(IdentityRateLimitBucket, fingerprint)
        return None if row is None else (row.attempt_count, row.blocked_until)


def provider_mutations(world):
    return [path for method, path in world.calls if path.endswith(("/challenge", "/verify"))]


def test_mfa_account_budget_cooldown_and_success_reset(budget_world):
    world = budget_world
    first, second = world.caller(), world.caller("198.51.100.22")
    before = world.sessions()
    for count in range(1, 6):
        if count == 5:
            world.clock += timedelta(minutes=14)
        response = verify(world, first if count % 2 else second, slot=count % 4)
        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "mfa_verification_failed"
        assert response.headers.get_list("set-cookie") == []
        # The route has rolled back before a separate connection observes this count.
        stored = budget(world, world.account_fingerprint)
        assert stored is not None and stored[0] == count
    assert [row.provider_access_token_encrypted for row in world.sessions()] == [
        row.provider_access_token_encrypted for row in before
    ]
    world.login_slot = 4
    assert (
        world.client.post(
            "/api/auth/token", json={"email": world.email, "password": world.password}
        ).status_code
        == 200
    )
    world.calls.clear()
    response = verify(world, second, slot=4)
    assert response.status_code == 429
    assert response.json() == {"detail": "Too many attempts"}
    assert response.headers["Retry-After"] == "900"
    assert response.headers.get_list("set-cookie") == []
    assert provider_mutations(world) == []
    with Session(world.owner) as db:
        denied = db.scalar(
            select(SecurityEvent).where(
                SecurityEvent.subject_id == world.actor_id,
                SecurityEvent.source == "identity.mfa_budget",
            )
        )
        assert denied is not None and denied.outcome == "denied"
    world.clock += timedelta(minutes=1)
    assert verify(world, second).headers["Retry-After"] == "840"
    with Session(world.owner) as db:
        assert (
            len(
                list(
                    db.scalars(
                        select(SecurityEvent).where(
                            SecurityEvent.subject_id == world.actor_id,
                            SecurityEvent.source == "identity.mfa_budget",
                        )
                    )
                )
            )
            == 1
        )
    world.clock += timedelta(minutes=14)
    world.hook = None
    assert verify(world, second).status_code == 200
    assert budget(world, world.account_fingerprint) is None
    assert budget(world, rate_limit_fingerprint("mfa-source", "198.51.100.22", None))[0] == 2
    world.hook = lambda request: (
        httpx.Response(400) if request.url.path.endswith("/verify") else None
    )
    assert verify(world, second).status_code == 400
    assert budget(world, world.account_fingerprint)[0] == 1


def test_mfa_source_budget_retains_failures_after_correct_codes(budget_world):
    world = budget_world
    caller = world.caller()
    denied = world.hook
    for _ in range(4):
        world.hook = denied
        for _ in range(4):
            assert verify(world, caller).status_code == 400
        world.hook = None
        assert verify(world, caller).status_code == 200
    world.hook = denied
    for _ in range(4):
        assert verify(world, caller).status_code == 400
    world.calls.clear()
    caller.headers["X-Forwarded-For"] = "198.51.100.99"
    assert verify(world, caller).status_code == 429
    assert provider_mutations(world) == []
    assert budget(world, world.account_fingerprint)[0] == 4
    assert budget(world, rate_limit_fingerprint("mfa-source", "198.51.100.21", None))[0] == 20
    # A different transport source still has its own allowance.
    assert verify(world, world.caller("198.51.100.23")).status_code == 400


def test_mfa_concurrent_sessions_share_the_remaining_account_allowance(budget_world):
    world = budget_world
    caller = world.caller()
    for _ in range(4):
        assert verify(world, caller).status_code == 400
    world.calls.clear()
    start = Barrier(2)
    callers = [world.caller("198.51.100.24"), world.caller("198.51.100.25")]

    def attempt(slot):
        start.wait(timeout=10)
        return verify(world, callers[slot], slot=slot).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(attempt, range(2))) == [400, 429]
    assert budget(world, world.account_fingerprint)[0] == 5
    assert len(provider_mutations(world)) == 2


def test_mfa_provider_unavailability_does_not_spend_failure_allowance(budget_world):
    world = budget_world
    world.hook = lambda request: (
        httpx.Response(503) if request.url.path.endswith("/verify") else None
    )
    response = verify(world, world.caller())
    assert response.status_code == 503
    assert response.headers.get_list("set-cookie") == []
    assert budget(world, world.account_fingerprint) is None


def test_mfa_budget_persistence_failure_is_unavailable(budget_world):
    world = budget_world

    def refuse_budget_flush(db, *_args):
        if any(isinstance(row, IdentityRateLimitBucket) for row in db.new):
            raise SQLAlchemyError("Controlled budget persistence failure")

    event.listen(AuditSession, "before_flush", refuse_budget_flush)
    try:
        response = verify(world, world.caller())
    finally:
        event.remove(AuditSession, "before_flush", refuse_budget_flush)
    assert response.status_code == 503
    assert response.headers.get_list("set-cookie") == []
    assert budget(world, world.account_fingerprint) is None
