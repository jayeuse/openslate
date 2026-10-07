"""Configured login budgets commit at actual HTTP and PostgreSQL boundaries."""

from datetime import timedelta
from uuid import uuid4

import httpx
import pytest
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentityRateLimitBucket
from app.systems.access.identity.rate_limits import login_fingerprint, rate_limit_fingerprint

pytest_plugins = ("tests.auth.session_policy_support",)

pytestmark = pytest.mark.integration


def wrong_password(world):
    attempts = []

    def reject(request):
        if request.url.path == "/auth/v1/token":
            attempts.append(request)
            return httpx.Response(400)
        return None

    world.hook = reject
    return attempts


@pytest.mark.parametrize("route", ["login", "token", "password/change"])
def test_threshold_one_keeps_first_failure_401_and_commits_cooldown(policy_world, route):
    world = policy_world
    world.policy(login_failed_attempt_threshold=1, login_window_minutes=2, login_cooldown_minutes=3)
    calls = wrong_password(world)
    if route == "password/change":
        payload = {"current_password": "Wrong current password", "password": world.password + "Aa9"}
        headers, source = world.headers(), None
    else:
        payload = {"email": world.email, "password": "Wrong current password"}
        headers, source = {}, "testclient"
    path = f"/api/auth/{route}"
    first = world.client.post(path, headers=headers, json=payload)
    assert first.status_code == (403 if route == "password/change" else 401)
    with Session(world.owner) as db:
        bucket = db.get(IdentityRateLimitBucket, login_fingerprint(world.email, source))
        assert bucket.attempt_count == 1
        assert bucket.blocked_until == world.clock + timedelta(minutes=3)
    second = world.client.post(path, headers=headers, json=payload)
    assert second.status_code == 429 and len(calls) == 1
    if route != "password/change":
        assert second.headers["retry-after"] == "180"


@pytest.mark.parametrize("route", ["login", "token"])
def test_existing_cooldown_uses_actual_remaining_retry_after_without_provider_call(
    policy_world, route
):
    world = policy_world
    world.policy(
        login_failed_attempt_threshold=100, login_window_minutes=1, login_cooldown_minutes=1
    )
    with Session(world.owner) as db:
        db.add(
            IdentityRateLimitBucket(
                fingerprint=login_fingerprint(world.email, "testclient"),
                attempt_count=5,
                window_started_at=world.clock - timedelta(minutes=5),
                blocked_until=world.clock + timedelta(seconds=90),
            )
        )
        db.commit()
    calls = wrong_password(world)
    result = world.client.post(
        f"/api/auth/{route}", json={"email": world.email, "password": "Wrong password"}
    )
    assert result.status_code == 429
    assert result.headers["retry-after"] == "90" and calls == []
    world.clock += timedelta(seconds=25)
    remaining = world.client.post(
        f"/api/auth/{route}", json={"email": world.email, "password": "Wrong password"}
    )
    assert remaining.status_code == 429 and remaining.headers["retry-after"] == "65"
    assert calls == []


def test_lowered_threshold_commits_immediate_block_before_refusing_admission(policy_world):
    world = policy_world
    world.policy(login_failed_attempt_threshold=2, login_window_minutes=5, login_cooldown_minutes=2)
    key = login_fingerprint(world.email, "testclient")
    with Session(world.owner) as db:
        db.add(
            IdentityRateLimitBucket(fingerprint=key, attempt_count=3, window_started_at=world.clock)
        )
        db.commit()
    calls = wrong_password(world)
    result = world.client.post(
        "/api/auth/token", json={"email": world.email, "password": "Wrong password"}
    )
    assert result.status_code == 429 and result.headers["retry-after"] == "120"
    assert calls == []
    with Session(world.owner) as db:
        bucket = db.get(IdentityRateLimitBucket, key)
        assert bucket.attempt_count == 3 and bucket.blocked_until == world.clock + timedelta(
            minutes=2
        )


def test_login_cleanup_keeps_48_hour_window_and_future_blocks(policy_world):
    world = policy_world
    keys = [rate_limit_fingerprint("recovery-source", uuid4().hex, None) for _ in range(3)]
    world.bucket_ids.extend(keys)
    with Session(world.owner) as db:
        for index, key in enumerate(keys):
            db.add(
                IdentityRateLimitBucket(
                    fingerprint=key,
                    attempt_count=1,
                    window_started_at=world.clock - timedelta(hours=47 if index == 0 else 49),
                    blocked_until=world.clock + timedelta(minutes=1) if index == 1 else None,
                )
            )
        db.commit()
    wrong_password(world)
    assert (
        world.client.post(
            "/api/auth/token", json={"email": world.email, "password": "Wrong password"}
        ).status_code
        == 401
    )
    with Session(world.owner) as db:
        assert db.get(IdentityRateLimitBucket, keys[0]) is not None
        assert db.get(IdentityRateLimitBucket, keys[1]) is not None
        assert db.get(IdentityRateLimitBucket, keys[2]) is None


def test_success_clears_login_budget_without_changing_fixed_recovery_budget(policy_world):
    world = policy_world
    world.policy(login_failed_attempt_threshold=2, login_window_minutes=2, login_cooldown_minutes=3)
    login = login_fingerprint(world.email, "testclient")
    recovery = rate_limit_fingerprint("recovery-recipient", world.email, None)
    world.bucket_ids.append(recovery)
    with Session(world.owner) as db:
        for key in (login, recovery):
            db.add(
                IdentityRateLimitBucket(
                    fingerprint=key, attempt_count=1, window_started_at=world.clock
                )
            )
        db.commit()
    world.login_slot = 4
    result = world.client.post(
        "/api/auth/token", json={"email": world.email, "password": world.password}
    )
    assert result.status_code == 200
    with Session(world.owner) as db:
        assert db.get(IdentityRateLimitBucket, login) is None
        assert db.get(IdentityRateLimitBucket, recovery).attempt_count == 1
