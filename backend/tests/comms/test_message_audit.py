"""Comms keeps redacted durable audit, but not personal-state or SSE noise."""

import json

import pytest
from sqlalchemy import bindparam, select, text
from uuid6 import uuid7

from app.systems.access.policy.models import Group
from tests.comms.conftest import NOW

pytestmark = pytest.mark.integration
D5_TABLES = frozenset({
    "comms_personal_preferences", "comms_member_preferences", "comms_read_states",
    "comms_conversation_counters", "comms_thread_follows",
})


def _logs(world, org):
    with world.owner.connect() as connection:
        return connection.execute(text(
            'SELECT entity_type,entity_id,action,performed_by,org_id,"before","after" '
            "FROM audit_logs WHERE org_id=:org ORDER BY id"
        ), {"org": org.id}).mappings().all()


def test_message_and_revision_content_stays_redacted_without_disabling_audit_or_other_sse(
    comms_world, monkeypatch,
):
    # Future model imports are setup prerequisites, never a manufactured red.
    from app.systems.comms.messages.models import CommsMessage, CommsMessageRevision

    org = comms_world.first
    original = f"originalcanary{uuid7().hex}"
    edited = f"editedcanary{uuid7().hex}"
    fingerprint = uuid7().hex * 2
    message_id, revision_id = uuid7(), uuid7()
    calls = []
    monkeypatch.setattr(
        "app.systems.manage.audit.listeners.publish_invalidations",
        lambda events, **_kwargs: calls.append(events),
    )
    with comms_world.session(org) as db:
        message = CommsMessage(
            id=message_id, org_id=org.id, conversation_id=org.conversation,
            author_id=org.author, client_key=uuid7(), seq=1, body=original,
            send_fingerprint=fingerprint,
        )
        db.add(message)
        db.commit()
        assert calls == []
        with comms_world.owner.connect() as connection:
            assert connection.execute(text(
                "SELECT body,body_tsv @@ plainto_tsquery('simple',:marker),send_fingerprint "
                "FROM comms_messages WHERE id=:id"
            ), {"marker": original, "id": message_id}).one() == (original, True, fingerprint)

        # These are actual ORM writes, not mocked snapshots or a synthetic audit row.
        db.refresh(message)
        db.add(CommsMessageRevision(
            id=revision_id, org_id=org.id, message_id=message_id,
            author_id=org.author, body=original,
        ))
        message.body = edited
        message.edited_at = NOW
        db.commit()
        assert calls == []
        with comms_world.owner.connect() as connection:
            assert connection.execute(text(
                "SELECT body,body_tsv @@ plainto_tsquery('simple',:marker) "
                "FROM comms_messages WHERE id=:id"
            ), {"marker": edited, "id": message_id}).one() == (edited, True)
        db.refresh(message)
        message.is_deleted = True
        message.deleted_at = NOW
        message.deleted_by = org.author
        db.commit()
        assert calls == []

    rows = _logs(comms_world, org)
    message_logs = {row["action"]: row for row in rows if row["entity_id"] == message_id}
    assert len([row for row in rows if row["entity_id"] == message_id]) == 3
    assert set(message_logs) == {"create", "update", "delete"}
    revision_logs = [row for row in rows if row["entity_id"] == revision_id]
    assert len(revision_logs) == 1
    assert revision_logs[0]["entity_type"] == "comms_message_revisions"
    assert revision_logs[0]["action"] == "create"
    assert revision_logs[0]["after"]["body"] == "[REDACTED]"
    for field in ("body", "body_tsv", "send_fingerprint"):
        assert message_logs["create"]["after"][field] == "[REDACTED]"
    assert message_logs["update"]["before"]["body"] == "[REDACTED]"
    assert message_logs["update"]["after"]["body"] == "[REDACTED]"
    assert message_logs["delete"]["after"]["is_deleted"] is True
    for row in rows:
        assert row["org_id"] == org.id
        assert row["performed_by"] == org.author
        snapshots = json.dumps([row["before"], row["after"]]).casefold()
        for private_value in (original, edited, fingerprint):
            assert private_value not in snapshots
        for snapshot in (row["before"], row["after"]):
            for field in ("body", "body_tsv", "send_fingerprint"):
                if snapshot is not None and field in snapshot:
                    assert snapshot[field] == "[REDACTED]"

    # A broad/global suppression fix would fail this real non-Comms commit.
    with comms_world.session(org) as db:
        group = db.get(Group, org.group)
        assert group is not None
        group.name = "Changed after Comms commit"
        db.commit()
    assert len(calls) == 1
    assert len(calls[0]) == 1
    [notification] = calls[0]
    assert notification.to_payload() == {"entity": "groups"}
    assert notification.org_id == org.id
    assert any(row["entity_type"] == "groups" and row["action"] == "update"
               for row in _logs(comms_world, org))


def test_all_five_d5_tables_and_both_preference_owners_remain_unaudited_on_each_mutation(
    comms_world,
):
    from app.systems.comms.conversations.models import CommsConversation
    from app.systems.comms.messages.interaction_models import CommsThreadFollow
    from app.systems.comms.messages.models import (
        CommsConversationCounter,
        CommsMessage,
        CommsReadState,
    )
    from app.systems.comms.settings.models import (
        CommsMemberPreferences,
        CommsPersonalPreferences,
    )

    org = comms_world.first
    conversation_id, message_id = uuid7(), uuid7()

    def assert_no_d5_audit():
        assert not [row for row in _logs(comms_world, org) if row["entity_type"] in D5_TABLES]

    with comms_world.session(org) as db:
        # Genuine audited parent creation makes an accidentally disabled audit pipeline fail.
        db.add(CommsConversation(
            id=conversation_id, org_id=org.id, kind="channel", scope="organization",
            name="D5 parent", topic="", position=0, created_by=org.author,
        ))
        db.add(CommsMessage(
            id=message_id, org_id=org.id, conversation_id=org.conversation,
            author_id=org.author, seq=1, client_key=uuid7(), body="Audited parent",
            send_fingerprint=uuid7().hex * 2,
        ))
        db.commit()
        assert any(row["entity_id"] == message_id and row["action"] == "create"
                   for row in _logs(comms_world, org))
        personal = CommsPersonalPreferences(
            id=uuid7(), org_id=org.id, user_id=org.author, values={"density": "comfortable"},
        )
        category = CommsMemberPreferences(
            id=uuid7(), org_id=org.id, category_id=org.category, user_id=org.author,
            collapsed=False, mute="off",
        )
        member = CommsMemberPreferences(
            id=uuid7(), org_id=org.id, conversation_id=org.conversation, user_id=org.author,
            notify="all", mute="off", starred=False, hidden=False, manual_unread=False,
        )
        read = CommsReadState(
            id=uuid7(), org_id=org.id, conversation_id=org.conversation,
            user_id=org.author, last_read_seq=0,
        )
        counter = CommsConversationCounter(
            id=uuid7(), org_id=org.id, conversation_id=conversation_id, last_seq=0,
        )
        follow = CommsThreadFollow(
            id=uuid7(), org_id=org.id, root_message_id=message_id, user_id=org.author,
        )
        private_rows = [personal, category, member, read, counter, follow]
        row_ids = [row.id for row in private_rows]
        db.add_all(private_rows)
        db.commit()
        assert_no_d5_audit()

        personal.values = {"density": "compact"}
        category.collapsed = True
        category.mute = "indefinite"
        member.manual_unread = True
        member.starred = True
        read.last_read_seq = 1
        counter.last_seq = 1
        follow.is_deleted = True
        follow.deleted_at = NOW
        db.commit()
        assert_no_d5_audit()
        # Verify writes actually reached PostgreSQL; an unaudited no-op is not a pass.
        with comms_world.owner.connect() as connection:
            assert connection.scalar(select(CommsPersonalPreferences.values).where(
                CommsPersonalPreferences.id == row_ids[0],
            )) == {"density": "compact"}
            assert connection.execute(select(
                CommsMemberPreferences.collapsed, CommsMemberPreferences.mute,
            ).where(CommsMemberPreferences.id == row_ids[1])).one() == (True, "indefinite")
            assert connection.execute(select(
                CommsMemberPreferences.manual_unread, CommsMemberPreferences.starred,
            ).where(CommsMemberPreferences.id == row_ids[2])).one() == (True, True)
            assert connection.scalar(select(CommsReadState.last_read_seq).where(
                CommsReadState.id == row_ids[3],
            )) == 1
            assert connection.scalar(select(CommsConversationCounter.last_seq).where(
                CommsConversationCounter.id == row_ids[4],
            )) == 1
            assert connection.scalar(select(CommsThreadFollow.is_deleted).where(
                CommsThreadFollow.id == row_ids[5],
            )) is True
        for row in private_rows:
            db.delete(row)
        db.commit()
        assert_no_d5_audit()
    with comms_world.owner.connect() as connection:
        for table in D5_TABLES:
            assert connection.scalar(text(
                f"SELECT count(*) FROM {table} WHERE id IN :ids"
            ).bindparams(bindparam("ids", expanding=True)), {"ids": row_ids}) == 0
