"""S20 events are exact, committed metadata, never a second authorization source."""

import pytest
from sqlalchemy import event, select
from sqlalchemy.exc import OperationalError
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.comms.messages.models import CommsMessage

pytestmark = pytest.mark.integration


def test_message_events_follow_real_changes_not_replays_or_failed_commits(message_routes):
    case, org = message_routes, message_routes.world.first
    api = case.client(org.author, org.id)
    events = []
    api.app.state.comms_publisher.submit = lambda rows: events.extend(rows)
    path = f"/api/comms/conversations/{org.conversation}/messages"
    payload = {"client_key": str(uuid7()), "body": "Not in an invalidation"}
    created = api.post(path, json=payload)
    assert created.status_code == 201
    message = created.json()
    expected = {
        "topic": f"org:{org.id}:conversation:{org.conversation}",
        "private": True,
        "event": "message",
        "payload": {"conversation_id": str(org.conversation), "seq": 1, "kind": "created"},
    }
    assert events == [expected]
    assert api.post(path, json=payload).status_code == 200
    assert events == [expected]
    changed = api.patch(
        path + f"/{message['id']}",
        json={
            "body": "Edited private text",
            "mention_user_ids": [],
            "mentions_channel": False,
            "mentions_here": False,
        },
    )
    assert changed.status_code == 200
    assert events[-1] == {**expected, "payload": {**expected["payload"], "kind": "edited"}}
    assert api.delete(path + f"/{message['id']}").status_code == 200
    assert events[-1] == {**expected, "payload": {**expected["payload"], "kind": "deleted"}}
    assert len(events) == 3
    before = list(events)
    failures = []
    changed_sessions = set()

    def observe_write(db, *_args):
        if db.get_bind() is case.world.runtime and any(
            isinstance(row, CommsMessage) for row in db.new
        ):
            changed_sessions.add(db)

    def reject_commit(db):
        if db in changed_sessions:
            failures.append(True)
            raise OperationalError("controlled commit refusal", {}, RuntimeError("controlled"))

    event.listen(AuditSession, "before_flush", observe_write)
    event.listen(AuditSession, "before_commit", reject_commit)
    try:
        failed = api.post(path, json={"client_key": str(uuid7()), "body": "Rolled back"})
    finally:
        event.remove(AuditSession, "before_commit", reject_commit)
        event.remove(AuditSession, "before_flush", observe_write)
    assert failures == [True] and failed.status_code == 503
    assert events == before
    with case.world.session(org) as db:
        assert list(db.scalars(select(CommsMessage.seq).where(CommsMessage.org_id == org.id))) == [
            1
        ]
    assert "private text" not in str(events) and "Rolled back" not in str(events)


def test_interaction_and_thread_events_are_change_only_and_read_sync_is_private(message_routes):
    case, org = message_routes, message_routes.world.first
    api = case.client(org.author, org.id)
    events = []
    api.app.state.comms_publisher.submit = lambda rows: events.extend(rows)
    collection = f"/api/comms/conversations/{org.conversation}/messages"
    response = api.post(collection, json={"client_key": str(uuid7()), "body": "Event source"})
    assert response.status_code == 201
    message = response.json()
    path = collection + "/" + message["id"]
    events.clear()
    for method, endpoint, body, changed in (
        ("POST", "/reactions", {"emoji": "👍"}, True),
        ("POST", "/reactions", {"emoji": "👍"}, False),
        ("DELETE", "/reactions", {"emoji": "👍"}, True),
        ("PUT", "/pin", {"pinned": True}, True),
        ("PUT", "/pin", {"pinned": True}, False),
        ("PUT", "/pin", {"pinned": False}, True),
    ):
        before = len(events)
        result = api.request(method, path + endpoint, json=body)
        assert result.status_code == 200
        assert len(events) == before + int(changed)
        if changed:
            assert events[-1]["payload"] == {
                "conversation_id": str(org.conversation),
                "seq": 1,
                "kind": "pin" if endpoint == "/pin" else "reaction",
            }
    thread = f"/api/comms/conversations/{org.conversation}/threads/{message['id']}"
    before = len(events)
    assert api.post(thread).status_code == 201
    assert len(events) == before + 1 and events[-1]["payload"]["kind"] == "thread"
    assert api.post(thread).status_code == 200
    assert len(events) == before + 1
    version = api.get(thread).headers["etag"]
    assert (
        api.patch(thread, headers={"If-Match": version}, json={"resolved": True}).status_code == 200
    )
    assert len(events) == before + 2 and events[-1]["payload"]["kind"] == "thread"
    assert api.put(thread + "/follow", json={"followed": False}).status_code == 200
    assert len(events) == before + 3
    assert api.put(thread + "/follow", json={"followed": False}).status_code == 200
    assert len(events) == before + 3
    read = f"/api/comms/conversations/{org.conversation}/read"
    assert api.put(read, json={"last_read_seq": 1}).status_code == 200
    assert events[-1] == {
        "topic": f"org:{org.id}:user:{org.author}",
        "private": True,
        "event": "read",
        "payload": {"conversation_id": str(org.conversation), "last_read_seq": 1},
    }
    count = len(events)
    assert api.put(read, json={"last_read_seq": 1}).status_code == 200
    assert len(events) == count


def test_structure_has_no_identifiers_and_personal_preferences_do_not_fan_out(structure_routes):
    from tests.comms.routes.structure_support import _channel

    case, org = structure_routes, structure_routes.world.first
    api = case.client(org.author, org.id)
    events = []
    api.app.state.comms_publisher.submit = lambda rows: events.extend(rows)
    created = api.post(
        "/api/comms/conversations",
        json=_channel("Private event room", scope="members", member_ids=[str(org.peer)]),
    )
    assert created.status_code == 201
    identity = created.json()["id"]
    user_topics = {f"org:{org.id}:user:{person}" for person in (org.author, org.peer)}
    structure = [row for row in events if row["event"] == "structure"]
    assert {row["topic"] for row in structure} == user_topics
    assert len(structure) == 2 and all(row["payload"] == {} and row["private"] for row in structure)
    assert {row["topic"] for row in events if row["event"] == "grants"} == user_topics
    assert "Private event room" not in str(events) and identity not in str(events)
    events.clear()
    path = f"/api/comms/conversations/{identity}"
    assert api.patch(path + "/preferences", json={"manual_unread": True}).status_code == 200
    assert events == [
        {
            "topic": f"org:{org.id}:user:{org.author}",
            "event": "membership",
            "private": True,
            "payload": {"conversation_id": identity},
        }
    ]
    events.clear()
    current = api.get(path)
    assert (
        api.delete(
            path + f"/members/{org.peer}", headers={"If-Match": current.headers["etag"]}
        ).status_code
        == 204
    )
    assert {row["topic"] for row in events if row["event"] == "membership"} == user_topics
    assert all(row["topic"] in user_topics for row in events)
    assert all(row["payload"] == {} for row in events if row["event"] in {"grants", "structure"})


def test_noop_direct_block_commands_do_not_refresh_another_users_grants(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    api = case.client(org.author, org.id)
    events = []
    api.app.state.comms_publisher.submit = lambda rows: events.extend(rows)
    path = "/api/comms/direct-blocks"
    assert api.delete(path + f"/{org.peer}").status_code == 204
    assert events == []
    assert api.post(path, json={"blocked_user_id": str(org.peer)}).status_code == 204
    assert {row["topic"] for row in events} == {
        f"org:{org.id}:user:{org.author}",
        f"org:{org.id}:user:{org.peer}",
    }
    assert len(events) == 2 and all(
        row["event"] == "grants" and row["payload"] == {} for row in events
    )
    events.clear()
    assert api.post(path, json={"blocked_user_id": str(org.peer)}).status_code == 204
    assert events == []
    assert api.delete(path + f"/{org.peer}").status_code == 204
    assert len(events) == 2
    events.clear()
    assert api.delete(path + f"/{org.peer}").status_code == 204
    assert events == []
