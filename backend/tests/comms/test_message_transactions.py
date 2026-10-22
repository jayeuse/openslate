"""Real send transactions: atomic rollback, replay and competing conversation locks."""

import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import pytest
from sqlalchemy import event, func, select, text
from uuid6 import uuid7

from tests.comms.conftest import NOW

pytestmark = pytest.mark.integration


def _send(world, api, command, *, conversation=None, actor=None, org=None):
    org = org or world.first
    with world.session(org, actor=actor) as db:
        result = api[1](db, org_id=org.id, author_id=actor or org.author,
                        conversation_id=conversation or org.conversation, command=command)
        return result.message.id, result.message.seq, result.replayed


def _stored_state(world):
    org = world.first
    with world.owner.connect() as connection:
        return {
            table: connection.execute(text(
                f"SELECT * FROM {table} WHERE org_id=:org ORDER BY id"
            ), {"org": org.id}).all()
            for table in (
                "comms_messages", "comms_conversation_counters", "comms_threads",
                "comms_mentions", "comms_message_attachments", "comms_message_record_links",
                "audit_logs",
            )
        }


def test_failed_reply_rolls_back_counter_thread_mentions_message_and_audit(comms_world, send_api):
    from app.systems.comms.messages.interaction_models import CommsMention, CommsThread
    from app.systems.comms.messages.models import CommsMessage

    Command, send_message, _, _ = send_api
    org = comms_world.first
    root, _, _ = _send(comms_world, send_api, Command(client_key=uuid7(), body="Root"))
    before = _stored_state(comms_world)
    reached = []
    command = Command(client_key=uuid7(), body="Reply", parent_id=root,
                      mention_user_ids=(org.peer, org.peer))

    class StorageFailure(RuntimeError):
        pass

    with comms_world.session(org) as db:
        def fail_after_staging(session):
            session.flush()
            assert session.scalar(
                select(func.count()).select_from(CommsMention).where(CommsMention.org_id == org.id)
            ) == 1
            assert session.scalar(
                select(CommsMessage.reply_count).where(CommsMessage.id == root)
            ) == 1
            assert session.scalar(
                select(func.count()).select_from(CommsThread).where(
                    CommsThread.root_message_id == root
                )
            ) == 1
            assert _stored_state(comms_world) == before, "uncommitted state escaped"
            reached.append(True)
            raise StorageFailure("controlled commit boundary failure")

        event.listen(db, "before_commit", fail_after_staging)
        with pytest.raises(StorageFailure):
            send_message(db, org_id=org.id, author_id=org.author,
                         conversation_id=org.conversation, command=command)
        event.remove(db, "before_commit", fail_after_staging)
        assert reached == [True]
        # The coordinating service owns rollback, not only context-manager cleanup.
        assert not db.in_transaction()
        assert _stored_state(comms_world) == before
    _, seq, replayed = _send(comms_world, send_api, command)
    assert (seq, replayed) == (2, False)


def test_replay_is_write_free_after_edit_and_tombstone_and_conflicts_do_not_allocate(
    comms_world, send_api,
):
    from app.systems.comms.messages.models import CommsMessage

    Command, _, Conflict, _ = send_api
    org = comms_world.first
    root, _, _ = _send(comms_world, send_api, Command(client_key=uuid7(), body="Root"))
    key = uuid7()
    command = Command(client_key=key, body="Original", parent_id=root,
                      mention_user_ids=(org.peer, org.peer))
    identity, seq, _ = _send(comms_world, send_api, command)
    for deleted in (False, True):
        with comms_world.session(org) as db:
            message = db.get(CommsMessage, identity)
            assert message is not None
            message.body = "Edited current body"
            message.edited_at = NOW
            message.is_deleted = deleted
            message.deleted_at = NOW if deleted else None
            message.deleted_by = org.author if deleted else None
            db.commit()
        before = _stored_state(comms_world)
        with comms_world.session(org) as db:
            replay = send_api[1](db, org_id=org.id, author_id=org.author,
                                 conversation_id=org.conversation, command=command)
            assert (replay.message.id, replay.message.seq, replay.replayed) == (identity, seq, True)
            assert replay.message.body == "Edited current body"
            assert replay.message.is_deleted is deleted
        assert _stored_state(comms_world) == before
        for changes in (
            {"body": "Different"}, {"parent_id": None}, {"reply_to_id": root},
            {"mention_user_ids": ()}, {"also_send_to_channel": True},
            {"mentions_channel": True}, {"mentions_here": True},
        ):
            with pytest.raises(Conflict):
                _send(comms_world, send_api, replace(command, **changes))
            assert _stored_state(comms_world) == before
        with pytest.raises(Conflict):
            _send(comms_world, send_api, command, conversation=org.other_conversation)
        assert _stored_state(comms_world) == before


@pytest.mark.parametrize("different_conversations", [False, True])
def test_competing_same_author_key_resolves_one_winner_without_consuming_loser_sequence(
    comms_world,
    send_api,
    different_conversations,
):
    Command, send_message, Conflict, _ = send_api
    org = comms_world.first
    command = Command(client_key=uuid7(), body="Concurrent send", mention_user_ids=(org.peer,))
    barrier = threading.Barrier(2, timeout=30)

    def send(conversation):
        with comms_world.session(org) as db:
            # Both sessions race admission; the author lock now serializes their inserts.
            db.connection()
            barrier.wait()
            try:
                result = send_message(
                    db,
                    org_id=org.id,
                    author_id=org.author,
                    conversation_id=conversation,
                    command=command,
                )
                return result.message.id, result.replayed
            except Conflict:
                assert not db.in_transaction()
                return "conflict", False

    targets = (
        org.conversation,
        org.other_conversation if different_conversations else org.conversation,
    )
    with ThreadPoolExecutor(max_workers=2) as workers:
        futures = [workers.submit(send, target) for target in targets]
        results = [future.result(timeout=30) for future in futures]
    assert sum(not replay and identity != "conflict" for identity, replay in results) == 1
    if different_conversations:
        assert sum(identity == "conflict" for identity, _ in results) == 1
    else:
        assert results[0][0] == results[1][0]
        assert sum(replay for _, replay in results) == 1
    with comms_world.owner.connect() as connection:
        assert connection.scalar(text(
            "SELECT count(*) FROM comms_messages WHERE org_id=:org"
        ), {"org": org.id}) == 1
        assert connection.scalar(text(
            "SELECT count(*) FROM comms_mentions WHERE org_id=:org"
        ), {"org": org.id}) == 1
        assert sorted(connection.scalars(text(
            "SELECT last_seq FROM comms_conversation_counters WHERE org_id=:org"
        ), {"org": org.id})) == [0, 1]
        assert connection.scalar(text(
            "SELECT count(*) FROM audit_logs WHERE org_id=:org "
            "AND entity_type='comms_messages' AND action='create'"
        ), {"org": org.id}) == 1


def test_two_first_replies_have_one_thread_and_atomic_root_metadata(comms_world, send_api):
    Command = send_api[0]
    org = comms_world.first
    root, _, _ = _send(comms_world, send_api, Command(client_key=uuid7(), body="Root"))
    barrier = threading.Barrier(2, timeout=30)

    def reply():
        barrier.wait()
        return _send(comms_world, send_api, Command(
            client_key=uuid7(), body="Reply", parent_id=root, mention_user_ids=(org.peer, org.peer),
        ))[0]

    with ThreadPoolExecutor(max_workers=2) as workers:
        futures = [workers.submit(reply) for _ in range(2)]
        replies = {future.result(timeout=30) for future in futures}
    with comms_world.owner.connect() as connection:
        assert connection.scalar(text(
            "SELECT count(*) FROM comms_threads WHERE org_id=:org AND root_message_id=:root"
        ), {"org": org.id, "root": root}) == 1
        stored = connection.execute(text(
            "SELECT id,created_at FROM comms_messages WHERE org_id=:org AND parent_id=:root"
        ), {"org": org.id, "root": root}).all()
        assert {row.id for row in stored} == replies
        assert connection.execute(text(
            "SELECT reply_count,last_reply_at FROM comms_messages WHERE id=:root"
        ), {"root": root}).one() == (2, max(row.created_at for row in stored))
        assert set(connection.execute(text(
            "SELECT message_id,user_id FROM comms_mentions WHERE org_id=:org"
        ), {"org": org.id})) == {(identity, org.peer) for identity in replies}


def test_nested_cross_conversation_and_cross_org_parents_fail_without_writes(comms_world, send_api):
    Command, _, _, Invalid = send_api
    org = comms_world.first
    root, _, _ = _send(comms_world, send_api, Command(client_key=uuid7(), body="Root"))
    reply, _, _ = _send(comms_world, send_api, Command(
        client_key=uuid7(), body="Reply", parent_id=root,
    ))
    foreign, _, _ = _send(comms_world, send_api, Command(client_key=uuid7(), body="Other"),
                          org=comms_world.second)
    before = _stored_state(comms_world)
    for parent, conversation in ((reply, org.conversation), (root, org.other_conversation),
                                 (foreign, org.conversation)):
        with pytest.raises(Invalid):
            _send(comms_world, send_api, Command(
                client_key=uuid7(), body="Invalid", parent_id=parent,
            ), conversation=conversation)
        assert _stored_state(comms_world) == before
