"""Actual send admission and linked-child rollback; no S16/S18 permission simulation."""

from dataclasses import replace

import pytest
from sqlalchemy import event, select, text
from uuid6 import uuid7

from tests.comms.conftest import NOW
from tests.comms.test_message_transactions import _send, _stored_state

pytestmark = pytest.mark.integration

# All future model/service imports are SETUP prerequisites, never meaningful red.


@pytest.mark.parametrize("body", [
    pytest.param(None, id="null-body"),
    pytest.param("", id="empty-without-links"),
    pytest.param(" \t\n", id="whitespace-without-links"),
    pytest.param("🪁" * 4001, id="4001-code-points"),
])
def test_invalid_body_is_refused_without_allocating_or_committing(comms_world, send_api, body):
    Command, _, _, Invalid = send_api
    command = Command(client_key=uuid7(), body=body)
    before = _stored_state(comms_world)
    with pytest.raises(Invalid):
        _send(comms_world, send_api, command)
    assert _stored_state(comms_world) == before


def test_send_accepts_four_thousand_unicode_code_points_without_truncation(comms_world, send_api):
    Command = send_api[0]
    body = "🪁" * 4000
    identity, seq, replayed = _send(comms_world, send_api, Command(client_key=uuid7(), body=body))
    assert (seq, replayed) == (1, False)
    with comms_world.owner.connect() as connection:
        assert connection.scalar(text(
            "SELECT body FROM comms_messages WHERE id=:id"
        ), {"id": identity}) == body


@pytest.mark.parametrize("link_kind", ["attachment", "record"])
def test_empty_body_with_a_structural_link_is_a_valid_send(
    comms_world, comms_links, send_api, link_kind,
):
    Command = send_api[0]
    files, records = comms_links
    changes = {"attachment_ids": (files[0],)} if link_kind == "attachment" else {
        "record_ids": (records[0],),
    }
    identity, seq, replayed = _send(
        comms_world, send_api, Command(client_key=uuid7(), body="", **changes),
    )
    assert (seq, replayed) == (1, False)
    with comms_world.owner.connect() as connection:
        assert connection.scalar(text(
            "SELECT body FROM comms_messages WHERE id=:id"
        ), {"id": identity}) == ""
        assert connection.scalars(text(
            "SELECT file_id FROM comms_message_attachments WHERE message_id=:id"
        ), {"id": identity}).all() == ([files[0]] if link_kind == "attachment" else [])
        assert connection.execute(text(
            "SELECT record_id,module_id FROM comms_message_record_links WHERE message_id=:id"
        ), {"id": identity}).all() == (
            [(records[0], comms_world.first.module)] if link_kind == "record" else []
        )


def test_last_safe_sequence_succeeds_then_exhaustion_refuses_but_replay_still_works(
    comms_world, send_api,
):
    from app.systems.comms.messages.models import CommsConversationCounter

    Command, _, _, Invalid = send_api
    org = comms_world.first
    with comms_world.session(org) as db:
        counter = db.scalar(select(CommsConversationCounter).where(
            CommsConversationCounter.org_id == org.id,
            CommsConversationCounter.conversation_id == org.conversation,
        ))
        assert counter is not None
        counter.last_seq = 9007199254740990
        db.commit()
    command = Command(client_key=uuid7(), body="Last safe allocation")
    identity, seq, replayed = _send(comms_world, send_api, command)
    assert (seq, replayed) == (9007199254740991, False)
    before = _stored_state(comms_world)
    with pytest.raises(Invalid):
        _send(comms_world, send_api, replace(command, client_key=uuid7()))
    assert _stored_state(comms_world) == before
    assert _send(comms_world, send_api, command) == (identity, 9007199254740991, True)
    assert _stored_state(comms_world) == before


@pytest.mark.parametrize("state", ["missing", "deleted"])
def test_missing_or_deleted_conversation_is_refused(comms_world, send_api, state):
    from app.systems.comms.conversations.models import CommsConversation

    Command, _, _, Invalid = send_api
    org = comms_world.first
    conversation = uuid7() if state == "missing" else org.conversation
    if state == "deleted":
        with comms_world.session(org) as db:
            row = db.get(CommsConversation, conversation)
            assert row is not None
            row.is_deleted = True
            row.deleted_at = NOW
            db.commit()
    before = _stored_state(comms_world)
    with pytest.raises(Invalid):
        _send(comms_world, send_api, Command(client_key=uuid7(), body="Refuse"),
              conversation=conversation)
    assert _stored_state(comms_world) == before


@pytest.mark.parametrize("reference", ["parent_id", "reply_to_id"])
def test_missing_root_or_quote_is_refused(comms_world, send_api, reference):
    Command, _, _, Invalid = send_api
    before = _stored_state(comms_world)
    with pytest.raises(Invalid):
        _send(comms_world, send_api, Command(
            client_key=uuid7(), body="Missing reference", **{reference: uuid7()},
        ))
    assert _stored_state(comms_world) == before


@pytest.mark.parametrize("reference", ["parent_id", "reply_to_id"])
def test_cached_live_reference_is_rechecked_after_another_session_deletes_it(
    comms_world, send_api, reference,
):
    from app.systems.comms.messages.models import CommsMessage

    Command, send_message, _, Invalid = send_api
    org = comms_world.first
    root, _, _ = _send(comms_world, send_api, Command(client_key=uuid7(), body="Root"))
    with comms_world.session(org) as caller:
        cached = caller.get(CommsMessage, root)
        assert cached is not None and cached.is_deleted is False
        with comms_world.session(org) as remover:
            row = remover.get(CommsMessage, root)
            assert row is not None
            row.is_deleted = True
            row.deleted_at = NOW
            row.deleted_by = org.author
            remover.commit()
        before = _stored_state(comms_world)
        with pytest.raises(Invalid):
            send_message(
                caller, org_id=org.id, author_id=org.author, conversation_id=org.conversation,
                command=Command(client_key=uuid7(), body="Stale reference", **{reference: root}),
            )
        assert not caller.in_transaction()
        assert _stored_state(comms_world) == before


def test_same_conversation_quote_does_not_create_a_thread(comms_world, send_api):
    Command = send_api[0]
    root, _, _ = _send(comms_world, send_api, Command(client_key=uuid7(), body="Quoted"))
    quoted, seq, replayed = _send(comms_world, send_api, Command(
        client_key=uuid7(), body="Quote response", reply_to_id=root,
    ))
    assert (seq, replayed) == (2, False)
    with comms_world.owner.connect() as connection:
        assert connection.execute(text(
            "SELECT parent_id,reply_to_id FROM comms_messages WHERE id=:id"
        ), {"id": quoted}).one() == (None, root)
        assert connection.scalar(text(
            "SELECT reply_count FROM comms_messages WHERE id=:id"
        ), {"id": root}) == 0
        assert connection.scalar(text(
            "SELECT count(*) FROM comms_threads WHERE org_id=:org"
        ), {"org": comms_world.first.id}) == 0


@pytest.mark.parametrize("foreign_scope", ["conversation", "organization"])
def test_quote_cannot_cross_conversation_or_organization(comms_world, send_api, foreign_scope):
    Command, _, _, Invalid = send_api
    org = comms_world.first
    foreign, _, _ = _send(
        comms_world, send_api, Command(client_key=uuid7(), body="Foreign quote"),
        org=comms_world.second if foreign_scope == "organization" else org,
        conversation=(comms_world.second.conversation if foreign_scope == "organization"
                      else org.other_conversation),
    )
    before = _stored_state(comms_world)
    with pytest.raises(Invalid):
        _send(comms_world, send_api, Command(
            client_key=uuid7(), body="Refuse quote", reply_to_id=foreign,
        ))
    assert _stored_state(comms_world) == before


@pytest.mark.parametrize("mismatch", ["organization", "author"])
def test_send_cannot_override_bound_organization_or_audit_actor(comms_world, send_api, mismatch):
    Command, send_message, _, Invalid = send_api
    org, other = comms_world.first, comms_world.second
    target = other.conversation if mismatch == "organization" else org.conversation
    before = _stored_state(comms_world)
    with comms_world.session(org) as db:
        with pytest.raises(Invalid):
            send_message(
                db, org_id=other.id if mismatch == "organization" else org.id,
                author_id=org.peer if mismatch == "author" else org.author,
                conversation_id=target,
                command=Command(client_key=uuid7(), body="Mismatched context"),
            )
        assert _stored_state(comms_world) == before
        with comms_world.owner.connect() as connection:
            assert connection.scalar(text(
                "SELECT count(*) FROM comms_messages WHERE org_id=:org"
            ), {"org": other.id}) == 0
            assert connection.scalar(text(
                "SELECT count(*) FROM audit_logs WHERE org_id=:org"
            ), {"org": other.id}) == 0
            assert connection.scalars(text(
                "SELECT last_seq FROM comms_conversation_counters WHERE org_id=:org"
            ), {"org": other.id}).all() == [0, 0]


def test_failure_after_both_link_types_are_staged_rolls_back_every_send_side_effect(
    comms_world, comms_links, send_api,
):
    from app.systems.comms.messages.interaction_models import CommsMention, CommsThread
    from app.systems.comms.messages.link_models import (
        CommsMessageAttachment,
        CommsMessageRecordLink,
    )
    from app.systems.comms.messages.models import CommsMessage

    Command, send_message, _, _ = send_api
    org = comms_world.first
    files, records = comms_links
    root, _, _ = _send(comms_world, send_api, Command(client_key=uuid7(), body="Root"))
    command = Command(
        client_key=uuid7(), body="Linked reply", parent_id=root, mention_user_ids=(org.peer,),
        attachment_ids=(files[0],), record_ids=(records[0],),
    )
    before = _stored_state(comms_world)
    reached = []

    class StorageFailure(RuntimeError):
        pass

    with comms_world.session(org) as db:
        def fail_after_children(session):
            session.flush()
            message = session.scalar(select(CommsMessage).where(
                CommsMessage.org_id == org.id, CommsMessage.client_key == command.client_key,
            ))
            assert message is not None and message.seq == 2
            assert session.scalars(select(CommsMessageAttachment.file_id).where(
                CommsMessageAttachment.message_id == message.id,
            )).all() == [files[0]]
            assert session.execute(select(
                CommsMessageRecordLink.record_id, CommsMessageRecordLink.module_id,
            ).where(CommsMessageRecordLink.message_id == message.id)).all() == [
                (records[0], org.module),
            ]
            assert session.scalars(select(CommsMention.user_id).where(
                CommsMention.message_id == message.id,
            )).all() == [org.peer]
            assert session.scalars(select(CommsThread.root_message_id).where(
                CommsThread.root_message_id == root,
            )).all() == [root]
            assert session.scalar(select(CommsMessage.reply_count).where(
                CommsMessage.id == root,
            )) == 1
            assert _stored_state(comms_world) == before, "uncommitted children escaped"
            reached.append(message.id)
            raise StorageFailure("controlled failure after both link types")

        event.listen(db, "before_commit", fail_after_children)
        try:
            with pytest.raises(StorageFailure):
                send_message(db, org_id=org.id, author_id=org.author,
                             conversation_id=org.conversation, command=command)
        finally:
            event.remove(db, "before_commit", fail_after_children)
        assert len(reached) == 1
        assert not db.in_transaction()
        assert _stored_state(comms_world) == before
    identity, seq, replayed = _send(comms_world, send_api, command)
    assert (seq, replayed) == (2, False)
    with comms_world.owner.connect() as connection:
        assert connection.scalars(text(
            "SELECT file_id FROM comms_message_attachments WHERE message_id=:id"
        ), {"id": identity}).all() == [files[0]]
        assert connection.execute(text(
            "SELECT record_id,module_id FROM comms_message_record_links WHERE message_id=:id"
        ), {"id": identity}).all() == [(records[0], org.module)]
