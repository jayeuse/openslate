"""Production ORM commits must be safe for an advancing after_seq reader."""

import threading
from concurrent.futures import ThreadPoolExecutor
from time import monotonic

import pytest
from sqlalchemy import event, select, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.organization_scope import apply_connection_scope
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.conftest import create_member
from tests.organization_scope_support import organization_bindings

pytestmark = pytest.mark.integration

# Page, old prefix and committed highwater come from ONE READ COMMITTED statement.
SNAPSHOT = text("""
    SELECT c.last_seq,
           ARRAY(SELECT m.seq FROM comms_messages m
                 WHERE m.org_id=c.org_id AND m.conversation_id=c.conversation_id
                   AND m.seq>:cursor ORDER BY m.seq LIMIT 17) AS page,
           ARRAY(SELECT m.seq FROM comms_messages m
                 WHERE m.org_id=c.org_id AND m.conversation_id=c.conversation_id
                   AND m.seq<=:cursor ORDER BY m.seq) AS prefix
      FROM comms_conversation_counters c
     WHERE c.org_id=:org AND c.conversation_id=:conversation
""")


def test_two_hundred_real_sends_never_commit_behind_an_advancing_reader(
    comms_world, record_property,
):
    # Proposed S15 internal API, not a stub or the S02 SQL implementation.
    # Until it exists an import failure is SETUP/UNRUN, never meaningful red.
    from app.systems.comms.messages.models import CommsMessage
    from app.systems.comms.messages.service import SendMessageCommand, send_message

    org = comms_world.first
    actors = [org.author, org.peer]
    with organization_bindings(), Session(comms_world.owner) as db:
        organization = db.get(WorkspaceProfile, org.id)
        assert organization is not None
        for _ in range(8):
            actor, _ = create_member(db, organization)
            actors.append(actor.id)
            comms_world.additional_users.append(actor.id)
        db.commit()
    barrier = threading.Barrier(201, timeout=30)
    writer_slots = threading.BoundedSemaphore(9)
    observed_intermediate = threading.Event()
    changed = threading.Condition()
    completed = 0
    keys = [uuid7() for _ in range(200)]

    def send(index, key):
        nonlocal completed
        actor = actors[index % len(actors)]  # Twenty real sends per eligible author.
        barrier.wait()
        try:
            with writer_slots, comms_world.session(org, actor=actor) as db:
                def hold_second_commit(session):
                    session.flush()
                    seq = session.scalar(
                        select(CommsMessage.seq).where(
                            CommsMessage.org_id == org.id,
                            CommsMessage.author_id == actor,
                            CommsMessage.client_key == key,
                        )
                    )
                    if seq == 2:
                        # Guarantees a live intermediate snapshot, not an inference
                        # from task completion counts. No allocation logic is mocked.
                        assert observed_intermediate.wait(5), "reader missed live commits"

                event.listen(db, "before_commit", hold_second_commit)
                result = send_message(
                    db, org_id=org.id, author_id=actor,
                    conversation_id=org.conversation,
                    command=SendMessageCommand(client_key=key, body=f"send {key}"),
                )
                assert result.replayed is False
                return result.message.id
        finally:
            with changed:
                completed += 1
                changed.notify_all()

    seen, highwaters = [], []
    generation = -1
    # Reserve the reader before writers queue: total checked-out connections <=10.
    with comms_world.runtime.connect() as reader, ThreadPoolExecutor(max_workers=200) as workers:
        futures = [workers.submit(send, index, key) for index, key in enumerate(keys)]
        try:
            barrier.wait()
            deadline = monotonic() + 30
            while True:
                assert monotonic() < deadline, "bounded ordering reader did not finish"
                with changed:
                    assert changed.wait_for(
                        lambda generation=generation: completed != generation, timeout=5,
                    )
                    generation = completed
                with reader.begin():
                    apply_connection_scope(reader, org.id)
                    highwater, page, prefix = reader.execute(SNAPSHOT, {
                        "org": org.id, "conversation": org.conversation,
                        "cursor": seen[-1] if seen else 0,
                    }).one()
                assert prefix == seen, "a committed message arrived behind the cursor"
                if page:
                    assert all(seq <= highwater for seq in page)
                    seen.extend(page)
                    highwaters.append(highwater)
                    if 0 < highwater < 200:
                        observed_intermediate.set()
                    generation = -1  # Drain bounded pages without needing another commit.
                elif generation == 200:
                    break
            ids = [future.result(timeout=30) for future in futures]
        finally:
            observed_intermediate.set()
            barrier.abort()

    assert len(set(ids)) == 200
    assert seen == list(range(1, 201))
    assert any(0 < highwater < 200 for highwater in highwaters)
    with comms_world.owner.connect() as connection:
        assert connection.scalars(text(
            "SELECT seq FROM comms_messages WHERE org_id=:org "
            "AND conversation_id=:conversation ORDER BY seq"
        ), {"org": org.id, "conversation": org.conversation}).all() == list(range(1, 201))
        assert set(connection.scalars(text(
            "SELECT client_key FROM comms_messages WHERE org_id=:org"
        ), {"org": org.id})) == set(keys)
        assert connection.scalar(text(
            "SELECT last_seq FROM comms_conversation_counters WHERE org_id=:org "
            "AND conversation_id=:conversation"
        ), {"org": org.id, "conversation": org.conversation}) == 200
    record_property("submitted_sends", 200)
    record_property("eligible_send_authors", len(actors))
    record_property("reader_committed_highwaters", highwaters)
    record_property("writer_connection_ceiling", 9)
