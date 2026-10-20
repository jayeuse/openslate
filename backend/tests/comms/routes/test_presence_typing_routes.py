"""S20 presence/typing and B8 bounded stateless recovery through real API and PostgreSQL."""

from datetime import timedelta

import pytest
from sqlalchemy import event, select

from app.core.database.base import Base
from app.systems.comms.conversations.models import CommsConversation, CommsMember
from app.systems.comms.settings.models import CommsMemberPreferences
from tests.comms.conftest import NOW

pytestmark = pytest.mark.integration
PRESENCE = "/api/comms/presence"


@pytest.fixture
def presence_case(structure_routes, budget_clock):
    yield structure_routes, budget_clock
    for name in ("comms_presence", "comms_typing"):
        if name not in Base.metadata.tables:
            continue
        model = next(
            mapper.class_ for mapper in Base.registry.mappers if mapper.local_table.name == name
        )
        for org in (structure_routes.world.first, structure_routes.world.second):
            with structure_routes.world.session(org) as db:
                for row in db.scalars(select(model).where(model.org_id == org.id)):
                    db.delete(row)
                db.commit()


def heartbeat(api, **values):
    response = api.post(PRESENCE, json={"state": "online", **values})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def test_presence_changes_are_org_scoped_and_typing_is_current_post_only_and_durable(presence_case):
    case, clock = presence_case
    org = case.world.first
    api = case.client(org.peer, org.id)
    events = []
    api.app.state.comms_publisher.submit = lambda rows: events.extend(rows)
    expected = {
        "org_id": str(org.id),
        "user_id": str(org.peer),
        "changed": [
            {"conversation_id": str(identity), "high_water_seq": 0}
            for identity in sorted((org.conversation, org.other_conversation))
        ],
        "truncated": False,
    }
    assert heartbeat(api) == expected
    assert events == [
        {
            "topic": f"org:{org.id}:presence",
            "event": "presence",
            "private": True,
            "payload": {"user_id": str(org.peer), "state": "online"},
        }
    ]
    assert heartbeat(api) == expected
    assert len(events) == 1
    snapshot = api.get(
        PRESENCE, params=[("user_ids", str(org.peer)), ("user_ids", str(case.world.second.peer))]
    )
    assert snapshot.status_code == 200
    assert snapshot.json() == {
        "org_id": str(org.id),
        "items": [{"user_id": str(org.peer), "state": "online"}],
    }
    heartbeat(api, state="away")
    assert events[-1]["payload"] == {"user_id": str(org.peer), "state": "away"}
    typing = f"/api/comms/conversations/{org.conversation}/typing"
    assert api.post(typing).status_code == 204
    assert events[-1] == {
        "topic": f"org:{org.id}:conversation:{org.conversation}",
        "event": "typing",
        "private": True,
        "payload": {"conversation_id": str(org.conversation), "user_id": str(org.peer)},
    }
    another_client = case.client(org.peer, org.id)
    denied = another_client.post(typing)
    assert denied.status_code == 429 and denied.headers["retry-after"] == "2"
    clock[0] += timedelta(seconds=2)
    assert another_client.post(typing).status_code == 204
    case.hide_other_conversation()
    assert api.post(f"/api/comms/conversations/{org.other_conversation}/typing").status_code == 404
    assert (
        api.post(f"/api/comms/conversations/{case.world.second.conversation}/typing").status_code
        == 404
    )
    for invalid in (
        {"state": "offline"},
        {"state": "online", "user_id": str(org.author)},
        {
            "state": "online",
            "known_sequences": [{"conversation_id": str(org.conversation), "high_water_seq": -1}],
        },
        {
            "state": "online",
            "known_sequences": [{"conversation_id": str(org.conversation), "high_water_seq": True}],
        },
    ):
        assert api.post(PRESENCE, json=invalid).status_code == 422
    assert api.get(PRESENCE, params=[("user_ids", str(org.peer))] * 2).status_code == 422


def test_heartbeat_filters_before_limiting_and_never_consumes_a_delivery_baseline(presence_case):
    case, clock = presence_case
    org = case.world.first
    ids = sorted([org.conversation, org.other_conversation, *case.seed_more_conversations(101)])
    api = case.client(org.author, org.id)
    first = heartbeat(api)
    assert first["changed"] == [{"conversation_id": str(i), "high_water_seq": 0} for i in ids[:100]]
    assert first["truncated"] is True
    assert heartbeat(api) == first  # Dropping a response cannot acknowledge any head.
    known = [{"conversation_id": str(i), "high_water_seq": 0} for i in ids[:100]]
    tail = heartbeat(api, known_sequences=known)
    assert tail["changed"] == [{"conversation_id": str(i), "high_water_seq": 0} for i in ids[100:]]
    assert tail["truncated"] is False
    for invalid in (
        known + [known[0]],
        [known[0], known[0]],
        [{"conversation_id": str(ids[0]), "high_water_seq": 9007199254740992}],
    ):
        assert (
            api.post(PRESENCE, json={"state": "online", "known_sequences": invalid}).status_code
            == 422
        )
    # Remove all but the first two from eligibility: live/read checks precede the limit.
    with case.world.session(org) as db:
        for identity in ids[2:]:
            db.get(CommsConversation, identity).archived_at = NOW
        private = db.get(CommsConversation, ids[1])
        private.scope = "members"
        for member in db.scalars(
            select(CommsMember).where(CommsMember.conversation_id == private.id)
        ):
            db.delete(member)
        db.commit()
    current = heartbeat(
        api,
        known_sequences=[
            {"conversation_id": str(ids[0]), "high_water_seq": 99},
            {"conversation_id": str(case.world.second.conversation), "high_water_seq": 0},
        ],
    )
    assert current["changed"] == [{"conversation_id": str(ids[0]), "high_water_seq": 0}]
    assert current["truncated"] is False
    # A wrong client-ahead head must repair downward; exact equality is the only known match.
    assert (
        heartbeat(api, known_sequences=[{"conversation_id": str(ids[0]), "high_water_seq": 0}])[
            "changed"
        ]
        == []
    )
    with case.world.session(org) as db:
        db.add(
            CommsMemberPreferences(
                org_id=org.id,
                user_id=org.author,
                conversation_id=ids[0],
                notify="mute",
                mute="off",
                starred=True,
                hidden=True,
                manual_unread=False,
            )
        )
        db.commit()
    assert heartbeat(api)["changed"] == []
    with case.world.session(org) as db:
        row = db.scalar(
            select(CommsMemberPreferences).where(CommsMemberPreferences.conversation_id == ids[0])
        )
        row.notify = "all"
        row.mute, row.muted_until = "until", NOW + timedelta(seconds=10)
        db.commit()
    assert heartbeat(api)["changed"] == []
    clock[0] += timedelta(seconds=10)
    assert heartbeat(api)["changed"] == [{"conversation_id": str(ids[0]), "high_water_seq": 0}]
    with case.world.session(org) as db:
        category = db.get(CommsConversation, ids[0]).category_id
        db.add(
            CommsMemberPreferences(
                org_id=org.id,
                user_id=org.author,
                category_id=category,
                collapsed=False,
                mute="until",
                muted_until=NOW + timedelta(seconds=20),
            )
        )
        db.commit()
    assert heartbeat(api)["changed"] == []
    clock[0] += timedelta(seconds=10)
    assert heartbeat(api)["changed"] == [{"conversation_id": str(ids[0]), "high_water_seq": 0}]


def test_presence_sweep_uses_the_120_second_grace_and_publishes_only_state_changes(
    presence_case, monkeypatch
):
    from app.systems.comms.realtime import publisher

    case, clock = presence_case
    org = case.world.first
    api = case.client(org.peer, org.id)
    worker, events = api.app.state.comms_publisher, []
    worker.submit = lambda rows: events.extend(rows)
    monkeypatch.setattr(publisher, "get_engine", lambda: case.world.runtime)
    heartbeat(api)
    events.clear()
    clock[0] = NOW + timedelta(seconds=119)
    worker._sweep()
    assert events == []
    clock[0] = NOW + timedelta(seconds=120)
    worker._sweep()
    assert events == [
        {
            "topic": f"org:{org.id}:presence",
            "event": "presence",
            "private": True,
            "payload": {"user_id": str(org.peer), "state": "offline"},
        }
    ]
    events.clear()
    clock[0] = NOW + timedelta(seconds=121)
    worker._sweep()
    assert events == []
    read = api.get(PRESENCE, params={"user_ids": str(org.peer)})
    assert read.status_code == 200 and read.json()["items"] == [
        {"user_id": str(org.peer), "state": "offline"}
    ]


def test_late_sweep_does_not_disclose_a_departed_member_to_new_presence_subscribers(
    presence_case, monkeypatch
):
    from app.systems.access.users.models import Membership
    from app.systems.comms.realtime import publisher

    case, clock = presence_case
    first, second = case.world.first, case.world.second
    left, right = case.client(first.peer, first.id), case.client(second.peer, second.id)
    heartbeat(left)
    heartbeat(right)
    with case.world.session(first) as db:
        membership = db.scalar(
            select(Membership).where(
                Membership.org_id == first.id, Membership.user_id == first.peer
            )
        )
        membership.is_deleted, membership.deleted_at = True, NOW
        db.commit()
    events = []
    worker = right.app.state.comms_publisher
    worker.submit = lambda rows: events.extend(rows)
    monkeypatch.setattr(publisher, "get_engine", lambda: case.world.runtime)
    clock[0] += timedelta(seconds=601)
    worker._sweep()
    assert events == [
        {
            "topic": f"org:{second.id}:presence",
            "event": "presence",
            "private": True,
            "payload": {"user_id": str(second.peer), "state": "offline"},
        }
    ]


def test_guest_presence_is_per_org_but_typing_never_inherits_home_admin_authority(presence_case):
    case, _clock = presence_case
    case.add_visited_guest()
    first, second = case.world.first, case.world.second
    visitor = case.client(first.author, second.id)
    assert heartbeat(visitor)["org_id"] == str(second.id)
    assert visitor.post(f"/api/comms/conversations/{second.conversation}/typing").status_code == 403
    home = case.client(first.author, first.id)
    assert home.get(PRESENCE, params={"user_ids": str(first.author)}).json()["items"] == [
        {"user_id": str(first.author), "state": "offline"}
    ]
    assert visitor.get(PRESENCE, params={"user_ids": str(first.author)}).json()["items"] == [
        {"user_id": str(first.author), "state": "online"}
    ]


def test_two_simultaneous_typing_requests_admit_only_one(presence_case):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    case, _clock = presence_case
    org, barrier = case.world.first, Barrier(2)
    left = case.client(org.peer, org.id, request_gate=barrier)
    right = case.client(org.peer, org.id, request_gate=barrier)
    path = f"/api/comms/conversations/{org.conversation}/typing"
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(left.post, path)
        second = pool.submit(right.post, path)
        outcomes = [first.result(timeout=20), second.result(timeout=20)]
    assert sorted(response.status_code for response in outcomes) == [204, 429]
    assert (
        next(response for response in outcomes if response.status_code == 429).headers[
            "retry-after"
        ]
        == "2"
    )


def test_heartbeat_head_projection_is_one_query_at_two_and_103_conversations(presence_case):
    case, _clock = presence_case
    org = case.world.first
    api = case.client(org.author, org.id)
    selects = []

    def observe(_connection, _cursor, statement, _params, _context, _many):
        if (
            statement.lstrip().upper().startswith("SELECT")
            and "comms_conversation_counters" in statement
        ):
            selects.append(True)

    event.listen(case.world.runtime, "after_cursor_execute", observe)
    try:
        assert len(heartbeat(api)["changed"]) == 2
        assert len(selects) == 1
        case.seed_more_conversations(101)
        selects.clear()
        page = heartbeat(api)
        assert len(page["changed"]) == 100 and page["truncated"] is True
        assert len(selects) == 1
    finally:
        event.remove(case.world.runtime, "after_cursor_execute", observe)
