"""Confirmation persistence contracts using the disposable lifecycle API actor."""

import os
import re
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe
from unittest.mock import Mock

import pytest
from sqlalchemy import event, func, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleActorBlocked,
    LifecycleActorMismatch,
    LifecycleChallengeBindingMismatch,
    LifecycleChallengeExhausted,
    LifecycleChallengeExpired,
    LifecycleChallengeNotFound,
    LifecycleInvalidCredentials,
    LifecyclePasswordServiceUnavailable,
    LifecycleUnsupportedOperation,
    LifecycleVerificationInProgress,
)
from app.systems.sandbox.lifecycle.models import LifecycleChallengeStatus as Status
from app.systems.sandbox.lifecycle.models import LifecycleConfirmationChallenge as Challenge
from app.systems.sandbox.lifecycle.models import LifecycleRateLimitBucket, LifecycleRateLimitFailure
from app.systems.sandbox.lifecycle.service import (
    begin_verification,
    consume_challenge,
    expire_challenge,
    invalidate_challenge,
    issue_challenge,
    record_failure,
    record_success,
    verify_challenge,
)
from tests.api_integration_support import create_owned_admin, delete_owned_admin

pytestmark = pytest.mark.integration
pytest_plugins = ("tests.lifecycle_integration.test_lifecycle_api_integration",)
NOW = datetime(2026, 9, 10, tzinfo=UTC)
_USER_LOCK = re.compile(r"\bFROM users\b.*\bFOR UPDATE\b", re.DOTALL)


def _issue(db, actor_id, *, now=NOW):
    return issue_challenge(db, actor_id, "close", "module", uuid7(), "impact", now=now)


def _reserve(db, issued, *, now=NOW):
    challenge = issued.challenge
    return begin_verification(
        db,
        issued.token,
        challenge.actor_id,
        "close",
        "module",
        challenge.target_id,
        "impact",
        now=now,
    )


def _verify(db, issued, provider, *, now=NOW):
    challenge = issued.challenge
    return verify_challenge(
        db,
        issued.token,
        challenge.actor_id,
        "close",
        "module",
        challenge.target_id,
        "impact",
        "actor@example.com",
        token_urlsafe(32),
        password_client=provider,
        now=now,
    )


def _count(db, model, actor_id):
    return db.scalar(select(func.count()).select_from(model).where(model.actor_id == actor_id))


@contextmanager
def _commit_before_actor_lock(engine: Engine, change: Callable[[], None]) -> Iterator[list[bool]]:
    """Run ``change`` once, just before the first ``FOR UPDATE`` read of a user row.

    ``change`` commits on its own connection before the lock is sent, so nothing is
    locked yet and, under READ COMMITTED, the locking read sees the commit. The list
    gets one ``True`` when ``change`` ran, so a pass cannot be vacuous.
    """

    fired: list[bool] = []

    def before_cursor_execute(_connection, _cursor, statement, *_args):
        if fired or not _USER_LOCK.search(statement):
            return
        fired.append(True)
        change()

    event.listen(engine, "before_cursor_execute", before_cursor_execute)
    try:
        yield fired
    finally:
        event.remove(engine, "before_cursor_execute", before_cursor_execute)


@pytest.fixture
def other_actor(lifecycle_api_client):
    """A second administrator; requesting the lifecycle client first keeps its guards."""

    owner_url = os.environ["MIGRATION_DATABASE_URL"]
    # Same organization: the actors differ, the organization does not.
    actor = create_owned_admin(
        os.environ["TEST_DATABASE_URL"], owner_url, "lifecycle-other",
        org_id=lifecycle_api_client().org_id,
    )
    try:
        yield actor
    finally:
        delete_owned_admin(owner_url, actor.id)


def _wrong_passwords():
    provider = Mock()
    provider.verify_password.side_effect = LifecycleInvalidCredentials("Invalid credentials")
    return provider


def test_wrong_password_can_retry_same_token_and_then_consume_once(lifecycle_api_client):
    client = lifecycle_api_client()
    provider = Mock()
    provider.verify_password.side_effect = [
        LifecycleInvalidCredentials("Invalid credentials"),
        client.actor.id,
    ]
    with Session(client.engine) as db:
        issued = _issue(db, client.actor.id)
        with pytest.raises(LifecycleInvalidCredentials):
            _verify(db, issued, provider)
        completed = _verify(db, issued, provider, now=NOW + timedelta(seconds=1))
        db.refresh(completed)
        assert completed.status == Status.CONSUMED
        assert completed.failed_attempts == 1
        assert completed.consumed_at == NOW + timedelta(seconds=1)
        with pytest.raises(LifecycleChallengeNotFound):
            _verify(db, issued, provider, now=NOW + timedelta(seconds=2))
        assert _count(db, LifecycleRateLimitFailure, client.actor.id) == 1
    assert provider.verify_password.call_count == 2


def test_fifth_wrong_password_exhausts_token_and_blocks_new_confirmations(lifecycle_api_client):
    client = lifecycle_api_client()
    provider = Mock()
    provider.verify_password.side_effect = LifecycleInvalidCredentials("Invalid credentials")
    with Session(client.engine) as db:
        issued = _issue(db, client.actor.id)
        for attempt in range(5):
            with pytest.raises(LifecycleInvalidCredentials):
                _verify(db, issued, provider, now=NOW + timedelta(seconds=attempt))
        db.refresh(issued.challenge)
        assert issued.challenge.status == Status.EXHAUSTED
        assert issued.challenge.failed_attempts == 5
        assert issued.challenge.consumed_at is None
        assert issued.challenge.verification_lease_id is None
        with pytest.raises(LifecycleChallengeExhausted):
            _verify(db, issued, provider, now=NOW + timedelta(seconds=5))
        db.rollback()
        with pytest.raises(LifecycleActorBlocked):
            _issue(db, client.actor.id, now=NOW + timedelta(seconds=5))
        assert _count(db, LifecycleRateLimitFailure, client.actor.id) == 5
    assert provider.verify_password.call_count == 5


def test_wrong_password_budget_blocks_new_challenges_then_recovers(lifecycle_api_client):
    client = lifecycle_api_client()
    provider = Mock()
    provider.verify_password.side_effect = LifecycleInvalidCredentials("Invalid credentials")
    with Session(client.engine) as db:
        for index in range(5):
            timestamp = NOW + timedelta(minutes=index * 2)
            issued = _issue(db, client.actor.id, now=timestamp)
            with pytest.raises(LifecycleInvalidCredentials):
                _verify(db, issued, provider, now=timestamp)
            db.refresh(issued.challenge)
            assert issued.challenge.failed_attempts == 1
            assert issued.challenge.consumed_at is None
        assert _count(db, LifecycleRateLimitFailure, client.actor.id) == 5
        with pytest.raises(LifecycleActorBlocked):
            _issue(db, client.actor.id, now=NOW + timedelta(minutes=9))
        recovered = _issue(db, client.actor.id, now=NOW + timedelta(minutes=24))
        assert recovered.challenge.status == Status.PENDING
        bucket = db.scalar(
            select(LifecycleRateLimitBucket).where(
                LifecycleRateLimitBucket.actor_id == client.actor.id,
            )
        )
        assert bucket.attempt_count == 0
        assert bucket.blocked_until is None
        assert _count(db, LifecycleRateLimitFailure, client.actor.id) == 0
    assert provider.verify_password.call_count == 5


def test_preview_cap_displaces_oldest_pending_but_never_inflight(lifecycle_api_client):
    client = lifecycle_api_client()
    with Session(client.engine) as db:
        first = _issue(db, client.actor.id)
        reserved = _issue(db, client.actor.id, now=NOW + timedelta(seconds=1))
        lease = _reserve(db, reserved, now=NOW + timedelta(seconds=2))
        third = _issue(db, client.actor.id, now=NOW + timedelta(seconds=3))
        fourth = _issue(db, client.actor.id, now=NOW + timedelta(seconds=4))
        db.refresh(first.challenge)
        db.refresh(reserved.challenge)
        assert first.challenge.status == Status.INVALIDATED
        assert reserved.challenge.status == Status.VERIFYING
        assert reserved.challenge.verification_lease_id == lease.lease_id
        _reserve(db, third, now=NOW + timedelta(seconds=5))
        _reserve(db, fourth, now=NOW + timedelta(seconds=6))
        with pytest.raises(LifecycleVerificationInProgress):
            _issue(db, client.actor.id, now=NOW + timedelta(seconds=7))
        assert (
            db.scalar(
                select(func.count())
                .select_from(Challenge)
                .where(
                    Challenge.actor_id == client.actor.id,
                    Challenge.status == Status.VERIFYING,
                )
            )
            == 3
        )
        recovered = _issue(db, client.actor.id, now=NOW + timedelta(minutes=6))
        assert recovered.challenge.status == Status.PENDING
        assert _count(db, Challenge, client.actor.id) == 1


def test_a_block_holds_its_full_time_after_the_oldest_failure_leaves_the_window(
    lifecycle_api_client,
):
    client = lifecycle_api_client()
    provider = _wrong_passwords()
    with Session(client.engine) as db:
        fifth = NOW + timedelta(minutes=14)
        for minute in (0, 4, 8, 12):
            issued = _issue(db, client.actor.id, now=NOW + timedelta(minutes=minute))
            with pytest.raises(LifecycleInvalidCredentials):
                _verify(db, issued, provider, now=NOW + timedelta(minutes=minute))
        waiting = _issue(db, client.actor.id, now=fifth - timedelta(minutes=1))
        last = _issue(db, client.actor.id, now=fifth)
        with pytest.raises(LifecycleInvalidCredentials):
            _verify(db, last, provider, now=fifth)
        # Two minutes later the minute-0 failure is out of the window; the block still holds.
        with pytest.raises(LifecycleActorBlocked):
            _reserve(db, waiting, now=fifth + timedelta(minutes=2))
        db.rollback()
        db.refresh(waiting.challenge)
        assert waiting.challenge.status == Status.PENDING
        assert waiting.challenge.verification_lease_id is None


def test_one_actors_confirmations_never_reach_or_change_another_actors(
    lifecycle_api_client, other_actor
):
    client = lifecycle_api_client()
    provider = _wrong_passwords()
    with Session(client.engine) as db:
        kept = _issue(db, other_actor.id)
        spent = _issue(db, other_actor.id, now=NOW + timedelta(seconds=1))
        for attempt in range(5):
            with pytest.raises(LifecycleInvalidCredentials):
                _verify(db, spent, provider, now=NOW + timedelta(seconds=2 + attempt))
        # The other actor is blocked and holds a pending challenge, an exhausted one and
        # five failures. None of it may block, count against, or be cleaned up by this actor.
        issued = [
            _issue(db, client.actor.id, now=NOW + timedelta(seconds=10 + index))
            for index in range(3)
        ]
        lease = _reserve(db, issued[-1], now=NOW + timedelta(seconds=13))
        assert lease.actor_id == client.actor.id
        db.refresh(kept.challenge)
        db.refresh(spent.challenge)
        assert kept.challenge.status == Status.PENDING
        assert spent.challenge.status == Status.EXHAUSTED
        assert _count(db, LifecycleRateLimitFailure, other_actor.id) == 5
        with pytest.raises(LifecycleActorBlocked):
            _issue(db, other_actor.id, now=NOW + timedelta(seconds=14))


def test_in_flight_verifications_count_against_their_own_actor_only(
    lifecycle_api_client, other_actor
):
    client = lifecycle_api_client()
    provider = _wrong_passwords()
    with Session(client.engine) as db:
        for index in range(2):
            other = _issue(db, other_actor.id, now=NOW + timedelta(seconds=index))
            _reserve(db, other, now=NOW + timedelta(seconds=index))
        failing = _issue(db, client.actor.id, now=NOW + timedelta(seconds=2))
        for attempt in range(3):
            with pytest.raises(LifecycleInvalidCredentials):
                _verify(db, failing, provider, now=NOW + timedelta(seconds=3 + attempt))
        second = _issue(db, client.actor.id, now=NOW + timedelta(seconds=6))
        third = _issue(db, client.actor.id, now=NOW + timedelta(seconds=7))
        # Three failures plus this actor's own verifications; the other actor's two
        # in-flight verifications never count here.
        _reserve(db, second, now=NOW + timedelta(seconds=8))
        _reserve(db, failing, now=NOW + timedelta(seconds=9))
        with pytest.raises(LifecycleActorBlocked):
            _reserve(db, third, now=NOW + timedelta(seconds=10))
        db.rollback()
        db.refresh(third.challenge)
        assert third.challenge.status == Status.PENDING


@pytest.mark.parametrize("binding", ["operation", "target_type", "target_id", "impact_digest"])
def test_wrong_binding_does_not_reserve_confirmation(lifecycle_api_client, binding):
    client = lifecycle_api_client()
    with Session(client.engine) as db:
        issued = _issue(db, client.actor.id)
        arguments = dict(
            operation="close",
            target_type="module",
            target_id=issued.challenge.target_id,
            impact_digest="impact",
        )
        arguments[binding] = uuid7() if binding == "target_id" else "mismatch"
        with pytest.raises(LifecycleChallengeBindingMismatch):
            begin_verification(db, issued.token, client.actor.id, **arguments, now=NOW)
        db.rollback()
        db.refresh(issued.challenge)
        assert issued.challenge.status == Status.PENDING
        assert issued.challenge.verification_lease_id is None
        assert issued.challenge.failed_attempts == 0
        assert _reserve(db, issued).challenge_id == issued.challenge_id


@pytest.mark.parametrize("identity", ["malformed", "different"])
def test_provider_identity_mismatch_never_consumes_confirmation(lifecycle_api_client, identity):
    client = lifecycle_api_client()
    provider = Mock()
    provider.verify_password.return_value = "not-a-uuid" if identity == "malformed" else uuid7()
    with Session(client.engine) as db:
        issued = _issue(db, client.actor.id)
        with pytest.raises(LifecycleActorMismatch):
            _verify(db, issued, provider)
        db.refresh(issued.challenge)
        assert issued.challenge.consumed_at is None
        assert issued.challenge.failed_attempts == 0
        assert issued.challenge.verification_lease_id is None
        assert issued.challenge.status == (
            Status.PENDING if identity == "malformed" else Status.INVALIDATED
        )
        if identity == "malformed":
            provider.verify_password.return_value = client.actor.id
            assert _verify(db, issued, provider).status == Status.CONSUMED
        else:
            with pytest.raises(LifecycleChallengeNotFound):
                _reserve(db, issued)


def test_provider_outage_releases_lease_without_spending_budget(lifecycle_api_client):
    client = lifecycle_api_client()
    provider = Mock()
    provider.verify_password.side_effect = LifecyclePasswordServiceUnavailable("Unavailable")
    with Session(client.engine) as db:
        issued = _issue(db, client.actor.id)
        with pytest.raises(LifecyclePasswordServiceUnavailable):
            _verify(db, issued, provider)
        db.refresh(issued.challenge)
        assert issued.challenge.status == Status.PENDING
        assert issued.challenge.failed_attempts == 0
        assert issued.challenge.verification_lease_id is None
        assert _count(db, LifecycleRateLimitFailure, client.actor.id) == 0
        provider.verify_password.side_effect = None
        provider.verify_password.return_value = client.actor.id
        assert _verify(db, issued, provider).status == Status.CONSUMED


@pytest.mark.parametrize("complete", [record_success, record_failure])
def test_password_completion_after_expiry_cannot_consume_or_charge(lifecycle_api_client, complete):
    client = lifecycle_api_client()
    with Session(client.engine) as db:
        issued = _issue(db, client.actor.id)
        lease = _reserve(db, issued)
        with pytest.raises(LifecycleChallengeExpired):
            complete(db, lease, now=NOW + timedelta(minutes=5))
        db.refresh(issued.challenge)
        assert issued.challenge.status == Status.EXPIRED
        assert issued.challenge.consumed_at is None
        assert issued.challenge.failed_attempts == 0
        assert issued.challenge.verification_lease_id is None


def test_stale_lease_and_replay_cannot_complete_another_verification(lifecycle_api_client):
    client = lifecycle_api_client()
    with Session(client.engine) as db:
        issued = _issue(db, client.actor.id)
        lease = _reserve(db, issued)
        with pytest.raises(LifecycleVerificationInProgress):
            consume_challenge(db, replace(lease, lease_id=uuid7()), now=NOW)
        db.rollback()
        assert consume_challenge(db, lease, now=NOW).status == Status.CONSUMED
        with pytest.raises(LifecycleChallengeNotFound):
            consume_challenge(db, issued.challenge_id, now=NOW)
        db.rollback()
        db.refresh(issued.challenge)
        assert issued.challenge.consumed_at == NOW
        assert issued.challenge.failed_attempts == 0


def test_a_lease_from_an_earlier_reservation_cannot_complete_the_next_one(
    lifecycle_api_client,
):
    client = lifecycle_api_client()
    with Session(client.engine) as db:
        issued = _issue(db, client.actor.id)
        earlier = _reserve(db, issued)
        record_failure(db, earlier, now=NOW)
        current = _reserve(db, issued, now=NOW + timedelta(seconds=1))
        with pytest.raises(LifecycleVerificationInProgress):
            record_success(db, earlier, now=NOW + timedelta(seconds=2))
        db.rollback()
        assert record_success(db, current, now=NOW + timedelta(seconds=2)).status == (
            Status.CONSUMED
        )


def test_a_failure_stops_counting_fifteen_minutes_after_it_happened(lifecycle_api_client):
    client = lifecycle_api_client()
    provider = _wrong_passwords()
    with Session(client.engine) as db:
        first = _issue(db, client.actor.id)
        for minute in range(4):
            with pytest.raises(LifecycleInvalidCredentials):
                _verify(db, first, provider, now=NOW + timedelta(minutes=minute))
        reserved = _issue(db, client.actor.id, now=NOW + timedelta(minutes=14))
        waiting = _issue(db, client.actor.id, now=NOW + timedelta(minutes=14, seconds=1))
        _reserve(db, reserved, now=NOW + timedelta(minutes=15, seconds=30))
        # At minute 16 the minute-0 failure no longer counts: three failures and one
        # verification in flight stay under the budget of five.
        lease = _reserve(db, waiting, now=NOW + timedelta(minutes=16))
        assert lease.challenge_id == waiting.challenge_id


def test_a_reservation_behind_another_for_the_same_token_refuses_the_leased_challenge(
    lifecycle_api_client,
):
    client = lifecycle_api_client()
    with Session(client.engine) as db:
        issued = _issue(db, client.actor.id)
        challenge_id, target_id = issued.challenge.id, issued.challenge.target_id
    leases = []

    def reserve(db):
        return begin_verification(
            db, issued.token, client.actor.id, "close", "module", target_id, "impact", now=NOW
        )

    def reserve_elsewhere():
        # A double submit: the other request leases the challenge and commits while
        # this one has read the token but not yet taken the actor lock.
        with Session(client.engine) as other:
            leases.append(reserve(other))

    with (
        Session(client.engine) as db,
        _commit_before_actor_lock(client.engine, reserve_elsewhere) as raced,
        pytest.raises(LifecycleVerificationInProgress),
    ):
        reserve(db)
    assert raced == [True]
    with Session(client.engine) as db:
        stored = db.get(Challenge, challenge_id)
        assert stored is not None
        assert stored.status == Status.VERIFYING
        assert stored.verification_lease_id == leases[0].lease_id


def test_invalidate_and_expire_preserve_terminal_consumed_state(lifecycle_api_client):
    client = lifecycle_api_client()
    with Session(client.engine) as db:
        issued = _issue(db, client.actor.id)
        lease = _reserve(db, issued)
        consume_challenge(db, lease, now=NOW)
        assert invalidate_challenge(db, issued.challenge_id, now=NOW).status == Status.CONSUMED
        assert (
            expire_challenge(db, issued.challenge_id, now=NOW + timedelta(minutes=6)).status
            == Status.CONSUMED
        )
        pending = _issue(db, client.actor.id)
        assert expire_challenge(db, pending.challenge_id, now=NOW).status == Status.PENDING
        assert (
            expire_challenge(db, pending.challenge_id, now=NOW + timedelta(minutes=5)).status
            == Status.EXPIRED
        )


@pytest.mark.parametrize(
    "operation", [record_failure, record_success, invalidate_challenge, expire_challenge]
)
def test_unknown_confirmation_is_not_found(lifecycle_api_client, operation):
    client = lifecycle_api_client()
    with Session(client.engine) as db:
        with pytest.raises(LifecycleChallengeNotFound):
            operation(db, uuid7(), now=NOW)


def test_unsupported_confirmation_operation_writes_nothing(lifecycle_api_client):
    client = lifecycle_api_client()
    with Session(client.engine) as db:
        with pytest.raises(LifecycleUnsupportedOperation):
            issue_challenge(db, client.actor.id, "reopen", "module", uuid7(), "impact", now=NOW)
        assert _count(db, Challenge, client.actor.id) == 0
