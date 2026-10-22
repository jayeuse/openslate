"""One-level threads, personal follows and sparse per-conversation reply cursors."""

from threading import Barrier
from uuid import UUID

import pytest
from sqlalchemy import select
from uuid6 import uuid7

from app.systems.comms.messages.interaction_models import CommsThread, CommsThreadFollow
from tests.comms.routes.message_support import send
from tests.comms.routes.structure_support import ROOT, _error, _ok, _race, _read, _tag

pytestmark = pytest.mark.integration


def test_reply_history_is_sparse_exclusive_and_root_tombstones_keep_thread_identity(message_routes):
    case, org = message_routes, message_routes.world.first
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    c = f"{ROOT}/conversations/{org.conversation}"
    root = send(admin, c + "/messages", "Root")
    t = c + f"/threads/{root['id']}"
    _error(admin.get(t), 404)
    with case.world.session(org) as db:
        assert list(db.scalars(select(CommsThread.id).where(CommsThread.org_id == org.id))) == []
    empty = _ok(admin.get(t + "/replies"))
    assert empty["items"] == [] and empty["thread_root_id"] == root["id"]
    assert empty["pagination"]["high_water_seq"] == 1
    first_payload = {
        "client_key": str(uuid7()),
        "body": "First reply",
        "also_send_to_channel": False,
    }
    first = _ok(peer.post(t + "/replies", json=first_payload), 201)
    assert first["parent_id"] == root["id"] and first["seq"] == 2
    thread = _read(peer, t)
    identity = thread.json()["id"]
    assert thread.json()["followed"] is True and thread.json()["reply_count"] == 1
    assert _ok(peer.post(t, json={}), 200)["id"] == identity
    ordinary = send(admin, c + "/messages", "Another root")
    second = send(peer, t + "/replies", "Visible reply", also_send_to_channel=True)
    tail = send(peer, t + "/replies", "Last reply")
    assert [ordinary["seq"], second["seq"], tail["seq"]] == [3, 4, 5]
    assert [m["seq"] for m in _ok(admin.get(c + "/messages"))["items"]] == [1, 3, 4]
    for query, expected in (
        ({"before_seq": 4}, [2]),
        ({"after_seq": 2}, [4, 5]),
        ({"around_seq": 4, "limit": 2}, [2, 4]),
    ):
        page = _ok(admin.get(t + "/replies", params=query))
        assert (
            page["thread_root_id"] == root["id"] and [m["seq"] for m in page["items"]] == expected
        )
        assert page["pagination"]["high_water_seq"] == 5
    assert _ok(admin.get(c + f"/messages/by-sequence/{tail['seq']}"))["id"] == tail["id"]
    replay = _ok(peer.post(t + "/replies", json=first_payload))
    assert replay["id"] == first["id"] and _read(peer, t).json()["reply_count"] == 3
    _error(peer.post(t + "/replies", json={**first_payload, "body": "Different"}), 409)
    _error(
        peer.post(
            c + f"/threads/{first['id']}/replies",
            json={"client_key": str(uuid7()), "body": "Nested"},
        ),
        404,
    )
    _error(
        peer.post(
            f"{ROOT}/conversations/{org.other_conversation}/threads/{root['id']}/replies",
            json={"client_key": str(uuid7()), "body": "Wrong parent"},
        ),
        404,
    )
    _ok(admin.delete(c + f"/messages/{root['id']}"))
    current = _read(admin, t).json()
    assert current["id"] == identity and current["reply_count"] == 3
    final = send(peer, t + "/replies", "Reply to tombstoned root")
    assert final["parent_id"] == root["id"] and _read(peer, t).json()["reply_count"] == 4
    _error(
        peer.post(
            c + "/messages",
            json={"client_key": str(uuid7()), "body": "Quote", "reply_to_id": root["id"]},
        ),
        404,
    )


def test_thread_configuration_capabilities_and_personal_follow_on_off_on(message_routes):
    case, org = message_routes, message_routes.world.first
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    c = f"{ROOT}/conversations/{org.conversation}"
    root = send(peer, c + "/messages")
    t = c + f"/threads/{root['id']}"
    created = peer.post(t)
    assert _ok(created, 201)["root_message_id"] == root["id"]
    assert created.headers["location"] == t
    _error(peer.patch(t, json={"resolved": True}), 428)
    initial = _read(peer, t)
    resolved = peer.patch(t, headers={"If-Match": _tag(initial)}, json={"resolved": True})
    assert _ok(resolved)["resolved"] is True
    _error(peer.patch(t, headers={"If-Match": _tag(initial)}, json={"resolved": False}), 412)
    _error(peer.patch(t, headers={"If-Match": _tag(resolved)}, json={"name": "Not a manager"}), 403)
    changed = admin.patch(
        t,
        headers={"If-Match": _tag(_read(admin, t))},
        json={"name": "Named", "locked": True, "archived": True},
    )
    assert _ok(changed)["name"] == "Named"
    _error(
        peer.post(t + "/replies", json={"client_key": str(uuid7()), "body": "Locked reply"}), 403
    )
    assert _ok(peer.get(ROOT + "/threads"))["items"] == []
    assert [
        row["id"]
        for row in _ok(
            peer.get(ROOT + "/threads", params={"archived": "true", "resolved": "true"})
        )["items"]
    ] == [created.json()["id"]]
    _ok(
        admin.patch(
            t, headers={"If-Match": _tag(changed)}, json={"locked": False, "archived": False}
        )
    )
    for followed in (False, True, False, True):
        value = _ok(peer.put(t + "/follow", json={"followed": followed}))
        assert value["followed"] is followed
        page = _ok(peer.get(ROOT + "/threads", params={"followed": "true"}))
        assert bool(page["items"]) is followed
        assert _read(admin, t).json()["followed"] is False
        if not followed:
            with case.world.session(org) as db:
                assert (
                    db.scalars(
                        select(CommsThreadFollow.id).where(
                            CommsThreadFollow.org_id == org.id,
                            CommsThreadFollow.root_message_id == UUID(root["id"]),
                            CommsThreadFollow.user_id == org.peer,
                        )
                    ).all()
                    == []
                )
    hidden = case.client(org.author, case.world.second.id)
    case.add_visited_guest()
    for suffix in ("", "/replies"):
        _error(hidden.get(t + suffix), 404)
    _error(hidden.put(t + "/follow", json={"followed": True}), 404)
    assert _ok(hidden.get(ROOT + "/threads"))["items"] == []


def test_competing_first_replies_converge_on_one_thread_and_separate_sequences(message_routes):
    case, org = message_routes, message_routes.world.first
    admin = case.client(org.author, org.id)
    c = f"{ROOT}/conversations/{org.conversation}"
    root = send(admin, c + "/messages")
    t = c + f"/threads/{root['id']}"
    gate = Barrier(2)
    a, b = (case.client(person, org.id, request_gate=gate) for person in (org.author, org.peer))
    results = _race(
        lambda: a.post(t + "/replies", json={"client_key": str(uuid7()), "body": "A"}),
        lambda: b.post(t + "/replies", json={"client_key": str(uuid7()), "body": "B"}),
    )
    assert [response.status_code for response in results] == [201, 201]
    assert {response.json()["seq"] for response in results} == {2, 3}
    current = _read(admin, t).json()
    assert current["reply_count"] == 2
    with case.world.session(org) as db:
        assert db.scalars(select(CommsThread.id).where(CommsThread.org_id == org.id)).all() == [
            UUID(current["id"])
        ]
