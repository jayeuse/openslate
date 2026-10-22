"""ID18: drained caller writes are still not owned by the coordinating send."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import select, text
from uuid6 import uuid7

from app.systems.manage.audit.models import AuditLog
from tests.comms.test_message_transactions import _send, _stored_state
from tests.race_support import WAIT, backend_pid, wait_until_blocked_by

pytestmark = pytest.mark.integration

# Missing service/model imports are setup failures, not a semantic red result.


def _committed_state(world):
    state = _stored_state(world)
    # The existing oracle covers send/counter/audit rows; also observe caller-only
    # category and read-state writes through an independent connection.
    with world.owner.connect() as connection:
        for table in ("comms_categories", "comms_read_states"):
            state[table] = connection.execute(text(
                f"SELECT * FROM {table} WHERE org_id=:org ORDER BY id"
            ), {"org": world.first.id}).all()
    return state


def _assert_committed_send(world, result, command, before):
    org = world.first
    assert (result.message.seq, result.replayed) == (1, False)
    with world.owner.connect() as connection:
        assert connection.execute(text(
            "SELECT id,seq,body FROM comms_messages WHERE org_id=:org"
        ), {"org": org.id}).all() == [(result.message.id, 1, command.body)]
        assert set(connection.execute(text(
            "SELECT conversation_id,last_seq FROM comms_conversation_counters WHERE org_id=:org"
        ), {"org": org.id})) == {(org.conversation, 1), (org.other_conversation, 0)}
    after = _committed_state(world)
    assert after["comms_categories"] == before["comms_categories"]
    assert after["comms_read_states"] == before["comms_read_states"]


def _assert_refusal_then_caller_rollback_allows_send(db, world, send_api, command, before):
    _, send_message, _, Invalid = send_api
    org = world.first
    assert _committed_state(world) == before, "caller work was committed during setup"
    with pytest.raises(Invalid):
        send_message(db, org_id=org.id, author_id=org.author,
                     conversation_id=org.conversation, command=command)
    # Observe refusal before caller/session cleanup could hide a partial commit.
    assert _committed_state(world) == before
    db.rollback()
    result = send_message(db, org_id=org.id, author_id=org.author,
                          conversation_id=org.conversation, command=command)
    _assert_committed_send(world, result, command, before)


@pytest.mark.parametrize("caller_write", ["counter_update", "read_state_insert"])
def test_flushed_unaudited_caller_work_is_refused_with_empty_orm_tracking(
    comms_world, send_api, caller_write,
):
    from app.systems.comms.messages.models import CommsConversationCounter, CommsReadState

    Command = send_api[0]
    org = comms_world.first
    command = Command(client_key=uuid7(), body="Not the caller's transaction")
    before = _committed_state(comms_world)
    with comms_world.session(org) as db:
        if caller_write == "counter_update":
            counter = db.scalar(select(CommsConversationCounter).where(
                CommsConversationCounter.org_id == org.id,
                CommsConversationCounter.conversation_id == org.other_conversation,
            ))
            assert counter is not None
            counter.last_seq = 7
        else:
            read_id = uuid7()
            db.add(CommsReadState(
                id=read_id, org_id=org.id, conversation_id=org.other_conversation,
                user_id=org.author, last_read_seq=0,
            ))
        db.flush()
        assert db.in_transaction()
        assert not db.new and not db.dirty and not db.deleted
        with db.no_autoflush:
            if caller_write == "counter_update":
                assert db.scalar(select(CommsConversationCounter.last_seq).where(
                    CommsConversationCounter.org_id == org.id,
                    CommsConversationCounter.conversation_id == org.other_conversation,
                )) == 7
            else:
                assert db.scalar(select(CommsReadState.id).where(
                    CommsReadState.id == read_id,
                )) == read_id
            assert db.scalars(select(AuditLog.id).where(AuditLog.org_id == org.id)).all() == []
        _assert_refusal_then_caller_rollback_allows_send(
            db, comms_world, send_api, command, before,
        )


def test_fully_flushed_category_and_audit_rows_still_belong_to_the_caller(comms_world, send_api):
    from app.systems.comms.conversations.models import CommsCategory

    Command = send_api[0]
    org = comms_world.first
    command = Command(client_key=uuid7(), body="Do not commit drained audited work")
    before = _committed_state(comms_world)
    with comms_world.session(org) as db:
        category = db.get(CommsCategory, org.category)
        assert category is not None
        category.name = "Uncommitted caller category"
        db.flush()
        db.flush()  # Persist audit rows too, rather than leaving them in session.new.
        assert db.in_transaction()
        assert not db.new and not db.dirty and not db.deleted
        with db.no_autoflush:
            assert db.scalar(select(CommsCategory.name).where(
                CommsCategory.id == org.category,
            )) == "Uncommitted caller category"
            assert len(db.scalars(select(AuditLog.id).where(
                AuditLog.org_id == org.id, AuditLog.entity_type == "comms_categories",
                AuditLog.entity_id == org.category, AuditLog.action == "update",
            )).all()) == 1
        _assert_refusal_then_caller_rollback_allows_send(
            db, comms_world, send_api, command, before,
        )


def test_inner_savepoint_rollback_does_not_give_send_ownership_of_outer_write(
    comms_world, send_api,
):
    from app.systems.comms.conversations.models import CommsCategory

    Command = send_api[0]
    org = comms_world.first
    command = Command(client_key=uuid7(), body="Outer work is still caller-owned")
    before = _committed_state(comms_world)
    with comms_world.session(org) as db:
        category = db.get(CommsCategory, org.category)
        assert category is not None
        category.name = "Surviving outer write"
        db.flush()
        db.flush()
        savepoint = db.begin_nested()
        category.name = "Rolled back inner write"
        db.flush()
        db.flush()
        savepoint.rollback()
        assert db.in_transaction() and not db.in_nested_transaction()
        assert not db.new and not db.dirty and not db.deleted
        with db.no_autoflush:
            # Query persisted transaction state, not the expired identity-map value.
            assert db.scalar(select(CommsCategory.name).where(
                CommsCategory.id == org.category,
            )) == "Surviving outer write"
            assert len(db.scalars(select(AuditLog.id).where(
                AuditLog.org_id == org.id, AuditLog.entity_type == "comms_categories",
                AuditLog.entity_id == org.category, AuditLog.action == "update",
            )).all()) == 1
        _assert_refusal_then_caller_rollback_allows_send(
            db, comms_world, send_api, command, before,
        )


def test_ordinary_read_autobegin_and_connection_transaction_still_accepts_send(
    comms_world, send_api,
):
    from app.systems.comms.conversations.models import CommsConversation

    Command, send_message, _, _ = send_api
    org = comms_world.first
    command = Command(client_key=uuid7(), body="Read-only caller is allowed")
    before = _committed_state(comms_world)
    with comms_world.session(org) as db:
        db.connection()
        assert db.scalar(select(CommsConversation.id).where(
            CommsConversation.org_id == org.id, CommsConversation.id == org.conversation,
        )) == org.conversation
        assert db.in_transaction()
        assert not db.new and not db.dirty and not db.deleted
        result = send_message(db, org_id=org.id, author_id=org.author,
                              conversation_id=org.conversation, command=command)
        _assert_committed_send(comms_world, result, command, before)


def test_authorization_after_counter_wait_observes_committed_membership_revocation(
    comms_world,
    send_api,
):
    from app.systems.access.users.membership import organization_membership
    from app.systems.access.users.models import User
    from app.systems.comms.access import require_conversation_access
    from app.systems.comms.messages.models import CommsConversationCounter

    Command, send_message, _, _ = send_api
    org = comms_world.first
    command = Command(client_key=uuid7(), body="Recheck after waiting")
    sender_pid, calls = [], []

    def send():
        with comms_world.session(org, actor=org.peer) as db:
            actor = db.get(User, org.peer)
            assert actor is not None
            require_conversation_access(db, actor, org.conversation, "post")
            assert db.connection().scalar(text("SHOW transaction_isolation")) == "read committed"
            sender_pid.append(backend_pid(db))

            def authorize(replayed):
                calls.append(replayed)
                require_conversation_access(
                    db,
                    actor,
                    org.conversation,
                    "read" if replayed else "post",
                )

            return send_message(
                db,
                org_id=org.id,
                author_id=org.peer,
                conversation_id=org.conversation,
                command=command,
                authorize=authorize,
            )

    with comms_world.session(org) as holder:
        assert (
            holder.scalar(
                select(CommsConversationCounter.id)
                .where(
                    CommsConversationCounter.org_id == org.id,
                    CommsConversationCounter.conversation_id == org.conversation,
                )
                .with_for_update()
            )
            is not None
        )
        with ThreadPoolExecutor(max_workers=1) as workers:
            pending = workers.submit(send)
            try:
                assert (
                    wait_until_blocked_by(comms_world.owner, backend_pid(holder)) == sender_pid[0]
                )
                with comms_world.session(org) as revoker:
                    membership = organization_membership(revoker, org.peer, fresh=True)
                    assert membership is not None
                    membership.is_deleted = True
                    revoker.commit()
                after_revocation = _committed_state(comms_world)
            finally:
                holder.rollback()
            with pytest.raises(HTTPException) as refused:
                pending.result(timeout=WAIT)
            assert refused.value.status_code == 404
    assert calls == [False]
    assert _committed_state(comms_world) == after_revocation


def test_replay_authorization_uses_current_read_rights_not_new_send_permissions(
    comms_world,
    send_api,
):
    from app.systems.access.users.membership import organization_membership
    from app.systems.access.users.models import User
    from app.systems.comms.access import require_conversation_access

    Command, send_message, _, _ = send_api
    org = comms_world.first
    command = Command(client_key=uuid7(), body="Readable after posting is revoked")
    original = _send(comms_world, send_api, command, actor=org.peer)
    calls = []
    with comms_world.session(org, actor=org.peer) as db:
        actor = db.get(User, org.peer)
        assert actor is not None
        require_conversation_access(db, actor, org.conversation, "post")

        def authorize(replayed):
            calls.append(replayed)
            require_conversation_access(
                db,
                actor,
                org.conversation,
                "read" if replayed else "post",
            )

        with comms_world.session(org) as writer:
            membership = organization_membership(writer, org.peer, fresh=True)
            assert membership is not None
            membership.role = "guest"
            membership.sponsor_user_id = org.author
            membership.expires_at = datetime(2100, 1, 1, tzinfo=UTC)
            writer.commit()
        before = _committed_state(comms_world)
        replay = send_message(
            db,
            org_id=org.id,
            author_id=org.peer,
            conversation_id=org.conversation,
            command=command,
            authorize=authorize,
        )
        assert (replay.message.id, replay.message.seq, replay.replayed) == (
            original[0],
            original[1],
            True,
        )
        assert calls == [True]
        with pytest.raises(HTTPException) as refused:
            send_message(
                db,
                org_id=org.id,
                author_id=org.peer,
                conversation_id=org.conversation,
                command=Command(client_key=uuid7(), body="Guest cannot post"),
                authorize=authorize,
            )
        assert refused.value.status_code == 403
        assert _committed_state(comms_world) == before
        with comms_world.session(org) as writer:
            membership = organization_membership(writer, org.peer, fresh=True)
            assert membership is not None
            membership.is_deleted = True
            writer.commit()
        after_revocation = _committed_state(comms_world)
        with pytest.raises(HTTPException) as refused:
            send_message(
                db,
                org_id=org.id,
                author_id=org.peer,
                conversation_id=org.conversation,
                command=command,
                authorize=authorize,
            )
        assert refused.value.status_code == 404
        assert not db.in_transaction()
    assert calls == [True, False, True]
    assert _committed_state(comms_world) == after_revocation
