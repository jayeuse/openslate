"""Real PostgreSQL transaction semantics; the live route proof owns transport assertions."""

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.systems.comms.messages.models import CommsMessage

pytestmark = pytest.mark.integration


def test_publication_buffer_preserves_outer_commit_and_savepoint_boundaries(comms_world):
    from app.systems.comms.realtime.publication import stage_comms_event, take_committed_events

    world, org = comms_world, comms_world.first

    def envelope(seq):
        return {
            "topic": f"org:{org.id}:conversation:{org.conversation}",
            "private": True,
            "event": "message",
            "payload": {"conversation_id": str(org.conversation), "seq": seq, "kind": "created"},
        }

    def stage(db, seq):
        db.add(
            CommsMessage(
                org_id=org.id,
                conversation_id=org.conversation,
                author_id=org.author,
                client_key=uuid7(),
                seq=seq,
                body="Never in an event",
                send_fingerprint="a" * 64,
            )
        )
        stage_comms_event(db, org_id=org.id, actor_id=org.author, envelope=envelope(seq))
        db.flush()

    with world.session(org) as db:
        stage(db, 1)
        with db.begin_nested():
            stage(db, 2)
        nested = db.begin_nested()
        stage(db, 3)
        nested.rollback()
        with db.begin_nested(), db.begin_nested():
            stage(db, 4)
        assert take_committed_events(db) == []
        db.commit()
        assert take_committed_events(db) == [envelope(1), envelope(2), envelope(4)]
        assert take_committed_events(db) == []
        with db.begin_nested():
            stage(db, 5)
        db.rollback()
        assert take_committed_events(db) == []
        stage(db, 6)
        with pytest.raises(IntegrityError):
            stage(db, 1)
        db.rollback()
        stage(db, 7)
        db.commit()
        assert take_committed_events(db) == [envelope(7)]
    with world.session(org) as db:
        assert list(
            db.scalars(
                select(CommsMessage.seq)
                .where(CommsMessage.conversation_id == org.conversation)
                .order_by(CommsMessage.seq)
            )
        ) == [1, 2, 4, 7]
        for invalid in (
            {**envelope(8), "payload": {**envelope(8)["payload"], "body": "forbidden"}},
            {**envelope(8), "topic": f"org:{world.second.id}:conversation:{org.conversation}"},
            {**envelope(8), "private": False},
        ):
            with pytest.raises(ValueError, match="extra_forbidden|context differs|Invalid private"):
                stage_comms_event(db, org_id=org.id, actor_id=org.author, envelope=invalid)
        db.commit()
        assert take_committed_events(db) == []
