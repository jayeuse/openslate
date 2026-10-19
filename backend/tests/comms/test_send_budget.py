"""Committed-message budgets share the send transaction, never durable slot rows."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
from datetime import timedelta
from threading import Event

import pytest
from fastapi import HTTPException
from sqlalchemy import event, select, text
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.access.users.membership import organization_membership
from app.systems.access.users.models import Membership, User
from app.systems.comms.access import require_conversation_access
from app.systems.comms.messages.models import CommsConversationCounter, CommsMessage
from tests.comms.conftest import NOW
from tests.comms.test_message_transactions import _send, _stored_state
from tests.race_support import WAIT, backend_pid, wait_until_blocked_by

pytestmark = pytest.mark.integration


def _command(api):
    return api[0](client_key=uuid7(), body="Budgeted message")


def _limited(world, api, seconds, **target):
    with pytest.raises(api[3]) as refused:
        _send(world, api, _command(api), **target)
    assert refused.value.retry_after == seconds


@contextmanager
def _hold_message_commit(world):
    held, release = Event(), Event()
    holder, touched = [], set()

    def observe(session, _flush_context, _instances):
        if session.get_bind() is world.runtime and any(
            isinstance(row, CommsMessage) for row in session.new
        ):
            touched.add(session)

    def hold(session):
        if session not in touched or held.is_set():
            return
        session.flush()
        holder.append(backend_pid(session))
        held.set()
        assert release.wait(WAIT), "held message transaction was not released"

    event.listen(AuditSession, "before_flush", observe)
    event.listen(AuditSession, "before_commit", hold)
    try:
        yield held, release, holder
    finally:
        release.set()
        event.remove(AuditSession, "before_commit", hold)
        event.remove(AuditSession, "before_flush", observe)


def test_staggered_rolling_expiry_and_rounded_retry_do_not_reset_or_extend(
    comms_world,
    send_api,
    budget_clock,
):
    for seconds in (0.25, 9.75):
        budget_clock[0] = NOW + timedelta(seconds=seconds)
        for _ in range(10):
            _send(comms_world, send_api, _command(send_api))
    for seconds in (10, 10.24):
        budget_clock[0] = NOW + timedelta(seconds=seconds)
        _limited(comms_world, send_api, 1)
    budget_clock[0] = NOW + timedelta(seconds=10.25)
    for _ in range(10):
        _send(comms_world, send_api, _command(send_api))
    _limited(comms_world, send_api, 10)
    budget_clock[0] = NOW + timedelta(seconds=10.26)
    _limited(comms_world, send_api, 10)
    budget_clock[0] = NOW + timedelta(seconds=19.74)
    _limited(comms_world, send_api, 1)
    budget_clock[0] = NOW + timedelta(seconds=19.75)
    for _ in range(10):
        _send(comms_world, send_api, _command(send_api))
    _limited(comms_world, send_api, 1)
    assert len(_stored_state(comms_world)["comms_messages"]) == 40


@pytest.mark.parametrize("contender", ["new", "replay", "conflict", "revoked"])
def test_nineteen_active_plus_two_competitors_admits_one_and_isolates_org_actor(
    comms_world,
    send_api,
    budget_clock,
    contender,
):
    org = comms_world.first
    command = _command(send_api)
    replay_checks = []

    def compete():
        if contender == "new":
            return _limited(comms_world, send_api, 10, conversation=org.other_conversation)
        with comms_world.session(org) as db:
            actor = db.get(User, org.author)
            assert actor is not None
            require_conversation_access(db, actor, org.conversation, "read")
            assert (
                db.scalar(
                    select(CommsMessage.id).where(
                        CommsMessage.org_id == org.id,
                        CommsMessage.author_id == org.author,
                        CommsMessage.client_key == command.client_key,
                    )
                )
                is None
            )  # The original is still uncommitted, so replay preflight misses.

            def authorize(replayed):
                replay_checks.append(replayed)
                require_conversation_access(
                    db,
                    actor,
                    org.conversation,
                    "read" if replayed else "post",
                )

            candidate = (
                replace(command, body="Different original") if contender == "conflict" else command
            )
            result = send_api[1](
                db,
                org_id=org.id,
                author_id=org.author,
                conversation_id=org.conversation,
                command=candidate,
                authorize=authorize,
            )
            return result.message.id, result.message.seq, result.replayed

    for _ in range(19):
        _send(comms_world, send_api, _command(send_api))
    with _hold_message_commit(comms_world) as (held, release, holder):
        with ThreadPoolExecutor(max_workers=2) as workers:
            first = workers.submit(_send, comms_world, send_api, command)
            try:
                assert held.wait(WAIT), "first message did not reach commit"
                second = workers.submit(compete)
                waiter = wait_until_blocked_by(comms_world.owner, holder[0])
                assert waiter != holder[0]
                with comms_world.owner.connect() as observer:
                    assert set(
                        observer.scalars(
                            text("SELECT locktype FROM pg_locks WHERE pid=:pid AND NOT granted"),
                            {"pid": waiter},
                        )
                    ) == {"advisory"}
                # The waiting sender must not have taken its different counter yet.
                with comms_world.session(org, actor=org.peer) as probe:
                    assert (
                        probe.scalar(
                            select(CommsConversationCounter.id)
                            .where(
                                CommsConversationCounter.conversation_id == org.other_conversation,
                            )
                            .with_for_update(nowait=True)
                        )
                        is not None
                    )
                    probe.rollback()
                if contender == "revoked":
                    with comms_world.session(org) as revoker:
                        membership = organization_membership(revoker, org.author, fresh=True)
                        assert membership is not None
                        membership.is_deleted = True
                        revoker.commit()
            finally:
                release.set()
            original = first.result(timeout=WAIT)
            assert original[2] is False
            if contender == "conflict":
                with pytest.raises(send_api[2]):
                    second.result(timeout=WAIT)
            elif contender == "revoked":
                with pytest.raises(HTTPException) as refused:
                    second.result(timeout=WAIT)
                assert refused.value.status_code == 404
            elif contender == "replay":
                assert second.result(timeout=WAIT) == (original[0], original[1], True)
            else:
                second.result(timeout=WAIT)
    assert len(_stored_state(comms_world)["comms_messages"]) == 20
    assert replay_checks == ([] if contender == "new" else [True])
    if contender != "new":
        return
    with comms_world.session(comms_world.second) as db:
        db.add(
            Membership(
                org_id=comms_world.second.id,
                user_id=org.author,
                role="member",
                status="active",
            )
        )
        db.commit()
    for target, actor in ((org, org.peer), (comms_world.second, org.author)):
        for _ in range(20):
            _send(comms_world, send_api, _command(send_api), org=target, actor=actor)
        _limited(comms_world, send_api, 10, org=target, actor=actor)
    _limited(comms_world, send_api, 10)


def test_waiting_admission_samples_fresh_time_after_the_author_lock(
    comms_world,
    send_api,
    budget_clock,
):
    for _ in range(19):
        _send(comms_world, send_api, _command(send_api))
    with _hold_message_commit(comms_world) as (held, release, holder):
        with ThreadPoolExecutor(max_workers=2) as workers:
            first = workers.submit(_send, comms_world, send_api, _command(send_api))
            try:
                assert held.wait(WAIT)
                second = workers.submit(
                    _send,
                    comms_world,
                    send_api,
                    _command(send_api),
                    conversation=comms_world.first.other_conversation,
                )
                assert wait_until_blocked_by(comms_world.owner, holder[0]) != holder[0]
                budget_clock[0] = NOW + timedelta(seconds=10)
            finally:
                release.set()
            assert first.result(timeout=WAIT)[2] is False
            assert second.result(timeout=WAIT)[2] is False
    for _ in range(19):
        _send(comms_world, send_api, _command(send_api))
    _limited(comms_world, send_api, 10)


def test_future_messages_are_not_discarded_when_the_clock_moves_back(
    comms_world,
    send_api,
    budget_clock,
):
    budget_clock[0] = NOW + timedelta(seconds=5)
    for _ in range(20):
        _send(comms_world, send_api, _command(send_api))
    budget_clock[0] = NOW
    _limited(comms_world, send_api, 15)
    budget_clock[0] = NOW + timedelta(seconds=15)
    _send(comms_world, send_api, _command(send_api))


def test_tombstones_still_count_but_known_replay_and_conflict_bypass_a_full_budget(
    comms_world,
    send_api,
    budget_clock,
):
    org = comms_world.first
    command = _command(send_api)
    original = _send(comms_world, send_api, command)
    for _ in range(19):
        _send(comms_world, send_api, _command(send_api))
    with comms_world.session(org) as db:
        message = db.get(CommsMessage, original[0])
        assert message is not None
        message.is_deleted, message.deleted_at = True, NOW
        db.commit()
    before = _stored_state(comms_world)
    _limited(comms_world, send_api, 10)
    replay = _send(comms_world, send_api, command)
    assert replay == (original[0], original[1], True)
    with pytest.raises(send_api[2]):
        _send(comms_world, send_api, replace(command, body="Different original"))
    assert _stored_state(comms_world) == before


def test_failed_send_rolls_back_without_consuming_the_last_committed_message_slot(
    comms_world,
    send_api,
    budget_clock,
):
    org = comms_world.first
    for _ in range(19):
        _send(comms_world, send_api, _command(send_api))
    command = _command(send_api)
    before = _stored_state(comms_world)

    class CommitFailure(RuntimeError):
        pass

    with comms_world.session(org) as db:

        def fail_commit(session):
            session.flush()
            assert _stored_state(comms_world) == before
            raise CommitFailure("controlled failed send")

        event.listen(db, "before_commit", fail_commit)
        try:
            with pytest.raises(CommitFailure):
                send_api[1](
                    db,
                    org_id=org.id,
                    author_id=org.author,
                    conversation_id=org.conversation,
                    command=command,
                )
        finally:
            event.remove(db, "before_commit", fail_commit)
        assert not db.in_transaction()
    assert _stored_state(comms_world) == before
    assert _send(comms_world, send_api, command)[2] is False
    _limited(comms_world, send_api, 10)
