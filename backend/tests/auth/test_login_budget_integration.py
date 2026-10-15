"""Password admission budgets through signed routes and durable PostgreSQL state."""

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
from app.systems.access.identity.rate_limits import login_fingerprint, rate_limit_fingerprint
from app.systems.manage.audit.models import SecurityEvent

pytest_plugins = ("tests.auth.session_policy_support",)
pytestmark = pytest.mark.integration


@pytest.fixture
def login_world(policy_world):
    world = policy_world
    access = world.access
    world.access = lambda *args, **kwargs: access(
        *args, exp=world.clock + timedelta(hours=1), **kwargs
    )
    world.policy(login_failed_attempt_threshold=100)
    world.bucket_ids.append(rate_limit_fingerprint("login-account", world.email, None))
    world.bucket_ids.append(rate_limit_fingerprint("recovery-recipient", world.email, None))
    callers = []

    def caller(source="198.51.100.31"):
        world.bucket_ids.extend(
            [
                rate_limit_fingerprint("login-source", source, None),
                rate_limit_fingerprint("recovery-source", source, None),
                login_fingerprint(world.email, source),
            ]
        )
        client = TestClient(
            world.client.app, base_url=get_settings().public_origin, client=(source, 50000)
        )
        client.headers["Origin"] = get_settings().public_origin
        callers.append(client)
        return client

    def wrong(request):
        if request.url.path == "/auth/v1/recover":
            return httpx.Response(200, json={})
        if request.url.path == "/auth/v1/token":
            return httpx.Response(400)
        return None

    world.hook = wrong
    world.caller = caller
    world.account_key = world.bucket_ids[0]
    try:
        yield world
    finally:
        for client in callers:
            client.close()


def attempt(world, client, route="token", email=None):
    return client.post(
        f"/api/auth/{route}", json={"email": email or world.email, "password": world.password}
    )


def budget(world, key):
    with Session(world.owner) as db:
        row = db.get(IdentityRateLimitBucket, key)
        return None if row is None else (row.attempt_count, row.blocked_until)


def grants(world):
    return [path for method, path in world.calls if path == "/auth/v1/token"]


def lockouts(world):
    with Session(world.owner) as db:
        return list(
            db.scalars(select(SecurityEvent).where(SecurityEvent.event_type == "identity.lockout"))
        )


@pytest.mark.parametrize(
    ("route", "stale_budget", "status"),
    [
        ("token", "account", 401),
        ("login", "source", 401),
        ("password/change", "account", 403),
        ("me/email", "account", 401),
    ],
)
def test_stale_login_budget_cleanup_preserves_failure_accounting(
    login_world, route, stale_budget, status
):
    world = login_world
    client = world.caller()
    key = (
        world.account_key
        if stale_budget == "account"
        else rate_limit_fingerprint("login-source", "198.51.100.31", None)
    )
    with Session(world.owner) as db:
        db.add(
            IdentityRateLimitBucket(
                fingerprint=key,
                attempt_count=9,
                window_started_at=world.clock - timedelta(hours=49),
                blocked_until=world.clock - timedelta(hours=48)
                if stale_budget == "source"
                else None,
            )
        )
        db.commit()
    if route in {"token", "login"}:
        response = attempt(world, client, route)
    else:
        payload = (
            {"current_password": world.password, "password": world.password + "Aa9"}
            if route == "password/change"
            else {"current_password": world.password, "email": "new-address@example.test"}
        )
        response = client.post(f"/api/auth/{route}", headers=world.headers(), json=payload)
    assert response.status_code == status
    assert response.headers.get_list("set-cookie") == []
    assert len(grants(world)) == 1
    assert budget(world, key) == (1, None)
    assert budget(world, world.account_key) == (1, None)


def test_login_account_budget_cooldown_recovery_and_success(login_world):
    world = login_world
    first, second = world.caller(), world.caller("198.51.100.32")
    before = len(lockouts(world))
    for count in range(10):
        if count == 9:
            world.clock += timedelta(minutes=14)
        response = attempt(
            world,
            first if count % 2 else second,
            "login" if count % 2 else "token",
            email="  " + world.email.upper() + "  ",
        )
        assert response.status_code == 401
    assert budget(world, world.account_key) == (10, world.clock + timedelta(minutes=15))
    world.calls.clear()
    refused = attempt(world, second)
    assert refused.status_code == 429
    assert refused.json() == {"detail": "Invalid authentication credentials"}
    assert refused.headers["Retry-After"] == "900"
    assert refused.headers.get_list("set-cookie") == [] and grants(world) == []
    assert len(lockouts(world)) == before + 1
    world.clock += timedelta(minutes=1)
    assert attempt(world, first).headers["Retry-After"] == "840"
    assert len(lockouts(world)) == before + 1
    recovery = second.post("/api/auth/recovery/request", json={"email": world.email})
    assert recovery.status_code == 204
    other = "unrelated@example.test"
    world.bucket_ids.extend(
        [
            rate_limit_fingerprint("login-account", other, None),
            login_fingerprint(other, "198.51.100.32"),
        ]
    )
    assert attempt(world, second, email=other).status_code == 401
    source_key = rate_limit_fingerprint("login-source", "198.51.100.32", None)
    assert budget(world, source_key) == (1, None)
    world.clock += timedelta(minutes=14)
    world.hook = None
    world.login_slot = 4
    assert attempt(world, second).status_code == 200
    assert budget(world, world.account_key) is None
    assert budget(world, login_fingerprint(world.email, "198.51.100.32")) is None
    assert budget(world, source_key) == (1, None)


def test_login_source_budget_fixed_window_and_transport_source(login_world):
    world = login_world
    client = world.caller()
    source_key = rate_limit_fingerprint("login-source", "198.51.100.31", None)
    before = len(lockouts(world))
    for count in range(30):
        email = f"candidate-{count}@example.test"
        world.bucket_ids.extend(
            [
                rate_limit_fingerprint("login-account", email, None),
                login_fingerprint(email, "198.51.100.31"),
            ]
        )
        if count == 29:
            world.clock += timedelta(minutes=14)
        assert attempt(world, client, email=email).status_code == 401
    world.calls.clear()
    client.headers["X-Forwarded-For"] = "198.51.100.99"
    refused = attempt(world, client)
    assert refused.status_code == 429 and refused.headers["Retry-After"] == "60"
    assert grants(world) == [] and len(lockouts(world)) == before + 1
    assert budget(world, source_key)[0] == 30
    assert attempt(world, world.caller("198.51.100.33")).status_code == 401
    world.clock += timedelta(minutes=1)
    assert attempt(world, client).status_code == 401
    assert budget(world, source_key) == (1, None)


@pytest.mark.parametrize("route", ["password/change", "me/email"])
def test_password_reauthentication_shares_login_account_budget(login_world, route):
    world = login_world
    client = world.caller()
    payload = (
        {"current_password": world.password, "password": world.password + "Aa9"}
        if route == "password/change"
        else {"current_password": world.password, "email": "new-address@example.test"}
    )
    for _ in range(9):
        assert attempt(world, client).status_code == 401
    response = client.post(f"/api/auth/{route}", headers=world.headers(), json=payload)
    assert response.status_code == (403 if route == "password/change" else 401)
    assert budget(world, world.account_key)[0] == 10
    world.calls.clear()
    assert (
        client.post(f"/api/auth/{route}", headers=world.headers(), json=payload).status_code == 429
    )
    assert grants(world) == []
    assert budget(world, rate_limit_fingerprint("login-source", "198.51.100.31", None))[0] == 9


@pytest.mark.parametrize("shared", ["account", "source"])
def test_concurrent_login_budget_accounting(login_world, shared):
    world = login_world
    key = (
        world.account_key
        if shared == "account"
        else rate_limit_fingerprint("login-source", "198.51.100.31", None)
    )
    world.bucket_ids.append(key)
    with Session(world.owner) as db:
        db.add(
            IdentityRateLimitBucket(
                fingerprint=key,
                attempt_count=9 if shared == "account" else 29,
                window_started_at=world.clock,
            )
        )
        db.commit()
    clients = [
        world.caller(),
        world.caller("198.51.100.34" if shared == "account" else "198.51.100.31"),
    ]
    other = "concurrent@example.test"
    world.bucket_ids.extend(
        [
            rate_limit_fingerprint("login-account", other, None),
            login_fingerprint(other, "198.51.100.31"),
        ]
    )
    start = Barrier(2)

    def send(index):
        start.wait(timeout=10)
        return attempt(
            world, clients[index], email=other if shared == "source" and index else None
        ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(send, range(2)))
    assert set(statuses) <= {401, 429} and 401 in statuses
    limit = 10 if shared == "account" else 30
    assert budget(world, key)[0] == limit - 1 + statuses.count(401)
    assert limit <= budget(world, key)[0] <= limit + 2
    assert len(grants(world)) == statuses.count(401)


def test_login_source_allows_independent_provider_calls(login_world):
    world = login_world
    clients = [world.caller(), world.caller()]
    emails = [world.email, "parallel@example.test"]
    world.bucket_ids.extend(
        [
            rate_limit_fingerprint("login-account", emails[1], None),
            login_fingerprint(emails[1], "198.51.100.31"),
        ]
    )
    provider = Barrier(2)

    def wrong(request):
        if request.url.path == "/auth/v1/token":
            provider.wait(timeout=10)
            return httpx.Response(400)
        return None

    world.hook = wrong
    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(
            pool.map(
                lambda index: attempt(world, clients[index], email=emails[index]).status_code,
                range(2),
            )
        )
    assert statuses == [401, 401]
    assert budget(world, rate_limit_fingerprint("login-source", "198.51.100.31", None))[0] == 2


def test_success_preserves_source_failure_budget(login_world):
    world = login_world
    client = world.caller()
    assert attempt(world, client).status_code == 401
    world.hook = None
    world.login_slot = 4
    assert attempt(world, client).status_code == 200
    assert budget(world, world.account_key) is None
    assert budget(world, login_fingerprint(world.email, "198.51.100.31")) is None
    assert budget(world, rate_limit_fingerprint("login-source", "198.51.100.31", None)) == (1, None)


def test_login_provider_failure_does_not_spend_budget(login_world):
    world = login_world
    world.hook = lambda request: (
        httpx.Response(503) if request.url.path == "/auth/v1/token" else None
    )
    assert attempt(world, world.caller()).status_code == 503
    assert budget(world, world.account_key) is None


def test_login_budget_persistence_failure_is_unavailable(login_world):
    world = login_world

    def refuse_flush(db, *_args):
        if any(isinstance(row, IdentityRateLimitBucket) for row in db.new):
            raise SQLAlchemyError("Controlled budget persistence failure")

    event.listen(AuditSession, "before_flush", refuse_flush)
    try:
        response = attempt(world, world.caller())
    finally:
        event.remove(AuditSession, "before_flush", refuse_flush)
    assert response.status_code == 503 and response.headers.get_list("set-cookie") == []
    assert budget(world, world.account_key) is None
