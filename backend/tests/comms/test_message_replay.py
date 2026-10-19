"""Remaining real-service replay invariants; existing scalar/race tests are reused."""

from dataclasses import replace

import pytest
from sqlalchemy import event, select, text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.core.database.base import Base
from tests.comms.conftest import NOW
from tests.comms.test_message_transactions import _send, _stored_state

pytestmark = pytest.mark.integration

# Future imports are SETUP prerequisites; no collection error is semantic red.


def test_set_valued_ids_replay_across_permutations_and_duplicates(
    comms_world, comms_links, send_api,
):
    Command = send_api[0]
    org = comms_world.first
    files, records = comms_links
    command = Command(
        client_key=uuid7(), body="Canonical sets",
        mention_user_ids=(org.peer, org.author, org.peer),
        attachment_ids=(files[1], files[0], files[1]),
        record_ids=(records[0], records[1], records[0]),
    )
    identity, seq, replayed = _send(comms_world, send_api, command)
    assert (seq, replayed) == (1, False)
    with comms_world.owner.connect() as connection:
        mentions = connection.scalars(text(
            "SELECT user_id FROM comms_mentions WHERE message_id=:id"
        ), {"id": identity}).all()
        attachments = connection.scalars(text(
            "SELECT file_id FROM comms_message_attachments WHERE message_id=:id"
        ), {"id": identity}).all()
        links = connection.execute(text(
            "SELECT record_id,module_id FROM comms_message_record_links WHERE message_id=:id"
        ), {"id": identity}).all()
    assert len(mentions) == 2 and set(mentions) == {org.author, org.peer}
    assert len(attachments) == 2 and set(attachments) == {files[0], files[1]}
    assert len(links) == 2 and set(links) == {
        (records[0], org.module), (records[1], org.module),
    }
    before = _stored_state(comms_world)
    replay_command = replace(
        command, mention_user_ids=(org.author, org.peer),
        attachment_ids=(files[0], files[1]),
        record_ids=(records[1], records[0], records[1]),
    )
    assert _send(comms_world, send_api, replay_command) == (identity, 1, True)
    assert _stored_state(comms_world) == before


@pytest.mark.parametrize("changed_set", ["attachment_ids", "record_ids"])
def test_changed_link_identity_conflicts_without_allocating_or_relinking(
    comms_world, comms_links, send_api, changed_set,
):
    Command, _, Conflict, _ = send_api
    files, records = comms_links
    command = Command(
        client_key=uuid7(), body="Original links",
        attachment_ids=(files[0],), record_ids=(records[0],),
    )
    _send(comms_world, send_api, command)
    before = _stored_state(comms_world)
    changed = (files[1],) if changed_set == "attachment_ids" else (records[1],)
    with pytest.raises(Conflict):
        _send(comms_world, send_api, replace(command, **{changed_set: changed}))
    assert _stored_state(comms_world) == before


def test_same_client_key_is_independent_per_author_and_per_organization(comms_world, send_api):
    Command = send_api[0]
    org, other = comms_world.first, comms_world.second
    # The SAME account belongs to both orgs; changing both org and author would not
    # detect an erroneous installation-wide (author,key) uniqueness rule.
    with comms_world.owner.begin() as connection:
        connection.execute(Base.metadata.tables["memberships"].insert().values(
            id=uuid7(), org_id=other.id, user_id=org.author, role="member", status="active",
        ))
        connection.execute(Base.metadata.tables["comms_members"].insert().values(
            id=uuid7(), org_id=other.id, conversation_id=other.conversation,
            user_id=org.author, role="member", joined_at=NOW,
        ))
    key = uuid7()
    command = Command(client_key=key, body="Scoped key")
    first = _send(comms_world, send_api, command)
    second_author = _send(comms_world, send_api, command, actor=org.peer)
    second_org = _send(comms_world, send_api, command, org=other, actor=org.author)
    assert len({first[0], second_author[0], second_org[0]}) == 3
    assert (first[1:], second_author[1:], second_org[1:]) == (
        (1, False), (2, False), (1, False),
    )
    other_message_query = text("SELECT * FROM comms_messages WHERE org_id=:org ORDER BY id")
    other_audit_query = text("SELECT * FROM audit_logs WHERE org_id=:org ORDER BY id")
    with comms_world.owner.connect() as connection:
        other_messages = connection.execute(other_message_query, {"org": other.id}).all()
        other_audit = connection.execute(other_audit_query, {"org": other.id}).all()
    before = _stored_state(comms_world)
    for target_org, actor, result in (
        (org, org.author, first), (org, org.peer, second_author), (other, org.author, second_org),
    ):
        assert _send(comms_world, send_api, command, org=target_org, actor=actor) == (
            result[0], result[1], True,
        )
    assert _stored_state(comms_world) == before
    with comms_world.owner.connect() as connection:
        assert connection.execute(other_message_query, {"org": other.id}).all() == other_messages
        assert connection.execute(other_audit_query, {"org": other.id}).all() == other_audit
        assert set(connection.execute(text(
            "SELECT org_id,author_id,client_key,seq FROM comms_messages "
            "WHERE org_id IN (:first,:second)"
        ), {"first": org.id, "second": other.id})) == {
            (org.id, org.author, key, 1), (org.id, org.peer, key, 2),
            (other.id, org.author, key, 1),
        }
        assert connection.scalar(text(
            "SELECT last_seq FROM comms_conversation_counters "
            "WHERE org_id=:org AND conversation_id=:conversation"
        ), {"org": other.id, "conversation": other.conversation}) == 1
        assert connection.scalar(text(
            "SELECT count(*) FROM audit_logs WHERE org_id=:org "
            "AND entity_type='comms_messages' AND entity_id=:id AND action='create'"
        ), {"org": other.id, "id": second_org[0]}) == 1


def test_root_tombstone_preserves_thread_and_existing_reply_replay(comms_world, send_api):
    from app.systems.comms.messages.models import CommsMessage

    Command = send_api[0]
    org = comms_world.first
    root, _, _ = _send(comms_world, send_api, Command(client_key=uuid7(), body="Root"))
    command = Command(client_key=uuid7(), body="Existing reply", parent_id=root)
    reply, seq, replayed = _send(comms_world, send_api, command)
    assert (seq, replayed) == (2, False)
    thread_query = text(
        "SELECT id,root_message_id,conversation_id,is_deleted "
        "FROM comms_threads WHERE root_message_id=:root"
    )
    with comms_world.owner.connect() as connection:
        thread = connection.execute(thread_query, {"root": root}).one()
        assert thread[1:] == (root, org.conversation, False)
    with comms_world.session(org) as db:
        message = db.get(CommsMessage, root)
        assert message is not None
        message.is_deleted = True
        message.deleted_at = NOW
        message.deleted_by = org.author
        db.commit()
    before = _stored_state(comms_world)
    # A retry is not a new reply to a deleted root; its existing identity survives.
    assert _send(comms_world, send_api, command) == (reply, 2, True)
    assert _stored_state(comms_world) == before
    with comms_world.owner.connect() as connection:
        assert connection.execute(thread_query, {"root": root}).one() == thread
        assert connection.execute(text(
            "SELECT parent_id,is_deleted FROM comms_messages WHERE id=:id"
        ), {"id": reply}).one() == (root, False)
        assert connection.execute(text(
            "SELECT is_deleted,reply_count FROM comms_messages WHERE id=:id"
        ), {"id": root}).one() == (True, 1)


def test_unrelated_unique_violation_propagates_and_rolls_back_instead_of_replaying(
    comms_world, send_api,
):
    from app.systems.comms.messages.interaction_models import CommsMention
    from app.systems.comms.messages.models import CommsMessage

    Command, send_message, _, _ = send_api
    org = comms_world.first
    command = Command(
        client_key=uuid7(), body="Real constraint failure", mention_user_ids=(org.peer,),
    )
    before = _stored_state(comms_world)
    reached = []
    with comms_world.session(org) as db:
        def violate_mention_uniqueness(session):
            session.flush()
            message = session.scalar(select(CommsMessage).where(
                CommsMessage.org_id == org.id, CommsMessage.client_key == command.client_key,
            ))
            assert message is not None
            assert session.scalars(select(CommsMention.user_id).where(
                CommsMention.message_id == message.id,
            )).all() == [org.peer]
            session.add(CommsMention(
                id=uuid7(), org_id=org.id, message_id=message.id, user_id=org.peer,
            ))
            reached.append(message.id)
            session.flush()  # Real PostgreSQL 23505, not a fabricated IntegrityError.

        event.listen(db, "before_commit", violate_mention_uniqueness)
        try:
            with pytest.raises(IntegrityError) as raised:
                send_message(db, org_id=org.id, author_id=org.author,
                             conversation_id=org.conversation, command=command)
        finally:
            event.remove(db, "before_commit", violate_mention_uniqueness)
        assert len(reached) == 1
        assert raised.value.orig.sqlstate == "23505"
        assert raised.value.orig.diag.table_name == "comms_mentions"
        assert not db.in_transaction()
        assert _stored_state(comms_world) == before
    _, seq, replayed = _send(comms_world, send_api, command)
    assert (seq, replayed) == (1, False)


@pytest.mark.parametrize("pending", ["new", "dirty", "deleted", "flushed"])
def test_send_refuses_to_commit_unrelated_caller_work(comms_world, send_api, pending):
    from app.systems.comms.conversations.models import CommsCategory

    Command, send_message, _, Invalid = send_api
    org = comms_world.first
    command = Command(client_key=uuid7(), body="Must own only its send")
    category_query = text(
        "SELECT id,name,is_deleted FROM comms_categories WHERE org_id=:org ORDER BY id"
    )
    before = _stored_state(comms_world)
    with comms_world.owner.connect() as connection:
        categories = connection.execute(category_query, {"org": org.id}).all()
    with comms_world.session(org) as db:
        if pending == "new":
            db.add(CommsCategory(
                id=uuid7(), org_id=org.id, name="Unrelated draft", position=1,
            ))
        else:
            category = db.get(CommsCategory, org.category)
            assert category is not None
            if pending == "deleted":
                db.delete(category)
            else:
                category.name = "Unrelated caller change"
                if pending == "flushed":
                    db.flush()
        with pytest.raises(Invalid):
            send_message(db, org_id=org.id, author_id=org.author,
                         conversation_id=org.conversation, command=command)
        # Whether caller work is retained or rolled back is not prescribed here;
        # it must never become committed, including via an autoflush before refusal.
        assert _stored_state(comms_world) == before
        with comms_world.owner.connect() as connection:
            assert connection.execute(category_query, {"org": org.id}).all() == categories
    _, seq, replayed = _send(comms_world, send_api, command)
    assert (seq, replayed) == (1, False)
