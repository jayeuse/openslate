"""Accepted S19 filter/page/current-source journeys, refreshed for the integrated S18 schema."""

from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy import select
from uuid6 import uuid7

from app.systems.comms.conversations.models import CommsConversation, CommsMember
from tests.comms.routes.structure_support import ROOT, _channel, _created, _ok

pytestmark = pytest.mark.integration
HIT_KEYS = {
    "message_id",
    "conversation_id",
    "conversation_name",
    "seq",
    "author_id",
    "author_name",
    "created_at",
    "excerpt",
    "matches",
    "parent_id",
}


def search(api, **filters):
    response = api.get(
        ROOT + "/search",
        params={
            "q": "kumquat",
            "sort_by": "created_at",
            "sort_order": "asc",
            **filters,
        },
    )
    assert response.status_code == 200, response.text
    assert "no-store" in response.headers["cache-control"]
    result = response.json()
    assert set(result) == {"items", "pagination"}
    assert set(result["pagination"]) == {"limit", "offset", "count", "total", "has_more"}
    for hit in result["items"]:
        assert set(hit) == HIT_KEYS
        UUID(hit["message_id"])
        assert datetime.fromisoformat(hit["created_at"]).utcoffset() is not None
    return result


def message_ids(result):
    return [hit["message_id"] for hit in result["items"]]


def test_search_filters_and_plain_excerpts_preserve_thread_context(search_case):
    case, org = search_case, search_case.world.first
    api = case.client(org.author, org.id)
    sent = api.post(
        f"{ROOT}/conversations/{org.conversation}/messages",
        json={
            "client_key": str(uuid7()),
            "body": "🧭 <b>kumquat</b>",
        },
    )
    assert sent.status_code == 201, sent.text
    ids = case.seed_search_filters(UUID(sent.json()["id"]))
    cases = [
        ({}, ["earlier", "root", "reply", "elsewhere", "file", "link", "record"]),
        ({"q": "papaya"}, ["decoy"]),
        ({"from": str(org.peer)}, ["file", "link"]),
        ({"in": str(org.other_conversation)}, ["elsewhere"]),
        ({"before": "2026-10-19"}, ["earlier"]),
        ({"after": "2026-10-19"}, ["record"]),
        ({"on": "2026-10-19"}, ["root", "reply", "elsewhere", "file", "link"]),
        ({"has": "file"}, ["file"]),
        ({"has": "link"}, ["link"]),
        ({"has": "record"}, ["record"]),
        ({"is": "pinned"}, ["file"]),
        ({"is": "thread"}, ["root", "reply"]),
        ({"q": "", "has": "file"}, ["file"]),
        ({"q": " kumquat "}, ["earlier", "root", "reply", "elsewhere", "file", "link", "record"]),
        (
            {
                "q": "kumquat",
                "from": str(org.peer),
                "in": str(org.conversation),
                "before": "2026-10-20",
                "after": "2026-10-18",
                "on": "2026-10-19",
                "has": "file",
                "is": "pinned",
            },
            ["file"],
        ),
    ]
    for filters, expected in cases:
        result = search(api, **filters)
        assert message_ids(result) == [str(ids[label]) for label in expected], filters
        assert result["pagination"] == {
            "limit": 25,
            "offset": 0,
            "count": len(expected),
            "total": len(expected),
            "has_more": False,
        }, filters
    hits = {hit["message_id"]: hit for hit in search(api)["items"]}
    for label, excerpt, matches in (
        ("earlier", "kumquat earlier", [{"start": 0, "end": 7}]),
        ("root", "🧭 <b>kumquat</b>", [{"start": 5, "end": 12}]),
        ("reply", "kumquat reply", [{"start": 0, "end": 7}]),
        ("elsewhere", "kumquat elsewhere", [{"start": 0, "end": 7}]),
        ("file", "kumquat file", [{"start": 0, "end": 7}]),
        ("link", "kumquat https://example.test", [{"start": 0, "end": 7}]),
        ("record", "kumquat record", [{"start": 0, "end": 7}]),
    ):
        assert hits[str(ids[label])]["excerpt"] == excerpt
        assert hits[str(ids[label])]["matches"] == matches
    root, reply = hits[str(ids["root"])], hits[str(ids["reply"])]
    assert (root["conversation_id"], root["conversation_name"], root["seq"]) == (
        str(org.conversation),
        "Channel 0",
        1,
    )
    assert (root["author_id"], root["author_name"], root["parent_id"]) == (
        str(org.author),
        "S19 author",
        None,
    )
    assert datetime.fromisoformat(root["created_at"]) == datetime(2026, 10, 19, tzinfo=UTC)
    assert (reply["conversation_id"], reply["seq"], reply["parent_id"]) == (
        str(org.conversation),
        3,
        str(ids["root"]),
    )
    assert (hits[str(ids["file"])]["author_id"], hits[str(ids["file"])]["author_name"]) == (
        str(org.peer),
        "S19 reader",
    )
    reader = case.client(org.peer, org.id)
    available = search(reader, **{"has": "record"})
    assert message_ids(available) == [str(ids["record"])]
    assert available["pagination"] == {
        "limit": 25,
        "offset": 0,
        "count": 1,
        "total": 1,
        "has_more": False,
    }
    case.revoke_search_record_access()
    assert search(reader, **{"has": "record"}) == {
        "items": [],
        "pagination": {
            "limit": 25,
            "offset": 0,
            "count": 0,
            "total": 0,
            "has_more": False,
        },
    }
    ordinary = search(reader)
    assert message_ids(ordinary) == [
        str(ids[label])
        for label in ("earlier", "root", "reply", "elsewhere", "file", "link", "record")
    ]
    assert ordinary["pagination"] == {
        "limit": 25,
        "offset": 0,
        "count": 7,
        "total": 7,
        "has_more": False,
    }
    hit = next(hit for hit in ordinary["items"] if hit["message_id"] == str(ids["record"]))
    assert hit["conversation_id"] == str(org.conversation)
    assert hit["excerpt"] == "kumquat record" and hit["matches"] == [{"start": 0, "end": 7}]


def test_search_offset_pages_are_bounded_and_stable_on_ties(search_case):
    case, org = search_case, search_case.world.first
    ids = case.seed_search_ties()
    api = case.client(org.author, org.id)
    first = search(api, limit=100)
    assert first["pagination"] == {
        "limit": 100,
        "offset": 0,
        "count": 100,
        "total": 102,
        "has_more": True,
    }
    assert len(set(message_ids(first))) == 100
    assert message_ids(first)[:3] == [str(ids[1]), str(ids[2]), str(ids[3])]
    assert message_ids(first)[-1] == str(ids[100])
    tail = search(api, limit=100, offset=100)
    assert message_ids(tail) == [str(ids[101]), str(ids[102])]
    assert tail["pagination"] == {
        "limit": 100,
        "offset": 100,
        "count": 2,
        "total": 102,
        "has_more": False,
    }
    assert set(message_ids(first)).isdisjoint(message_ids(tail))
    assert search(api, limit=100, offset=102) == {
        "items": [],
        "pagination": {
            "limit": 100,
            "offset": 102,
            "count": 0,
            "total": 102,
            "has_more": False,
        },
    }
    for sort in ("created_at", "relevance"):
        head, next_page = (
            search(api, sort_by=sort, limit=2),
            search(api, sort_by=sort, limit=2, offset=2),
        )
        assert message_ids(head) == [str(ids[1]), str(ids[2])]
        assert message_ids(next_page) == [str(ids[3]), str(ids[4])]
        assert search(api, sort_by=sort, limit=2) == head
        assert message_ids(search(api, sort_by=sort, sort_order="desc", limit=2)) == [
            str(ids[102]),
            str(ids[101]),
        ]
    oversized = api.get(ROOT + "/search", params={"q": "kumquat", "limit": 101})
    assert oversized.status_code == 422, oversized.text


def test_search_rechecks_current_source_access_without_leaking_hidden_hits(search_case):
    case, first, second = search_case, search_case.world.first, search_case.world.second
    ids = case.seed_search_visibility()
    reader, admin, foreign_reader = (
        case.client(first.peer, first.id),
        case.client(first.author, first.id),
        case.client(second.peer, second.id),
    )
    assert message_ids(search(admin)) == [str(ids[k]) for k in ("revocable", "reply", "private")]
    assert message_ids(search(foreign_reader)) == [str(ids["foreign"])]
    before = search(reader)
    assert message_ids(before) == [str(ids["revocable"]), str(ids["reply"])]
    assert before["pagination"] == {
        "limit": 25,
        "offset": 0,
        "count": 2,
        "total": 2,
        "has_more": False,
    }
    case.routes.hide_other_conversation()
    after = search(reader)
    assert message_ids(after) == [str(ids["reply"])]
    assert after["pagination"] == {
        "limit": 25,
        "offset": 0,
        "count": 1,
        "total": 1,
        "has_more": False,
    }
    assert after["items"][0]["excerpt"] == "kumquat surviving"
    assert after["items"][0]["matches"] == [{"start": 0, "end": 7}]
    assert after["items"][0]["parent_id"] == str(ids["tombstone"])
    assert after["items"][0]["conversation_id"] == str(first.conversation)
    page = search(reader, limit=1)
    assert message_ids(page) == [str(ids["reply"])]
    assert page["pagination"] == {
        "limit": 1,
        "offset": 0,
        "count": 1,
        "total": 1,
        "has_more": False,
    }
    assert search(reader, limit=1, offset=1) == {
        "items": [],
        "pagination": {
            "limit": 1,
            "offset": 1,
            "count": 0,
            "total": 1,
            "has_more": False,
        },
    }
    denied = reader.get(
        f"{ROOT}/conversations/{first.other_conversation}/messages/{ids['revocable']}"
    )
    assert denied.status_code == 404, denied.text
    assert message_ids(search(admin)) == [str(ids[k]) for k in ("revocable", "reply", "private")]
    _, private = _created(admin, ROOT + "/conversations", _channel("D43 search"))
    sent = _ok(
        reader.post(private + "/messages", json={"client_key": str(uuid7()), "body": "starfruit"}),
        201,
    )
    with case.world.session(first) as db:
        # D43: a group message the admin left; D44 has no private channel.
        room = db.get(CommsConversation, UUID(private.rsplit("/", 1)[-1]))
        room.kind, room.scope, room.category_id = "group", "members", None
        db.add(CommsMember(org_id=first.id, conversation_id=room.id, user_id=first.peer))
        for member in db.scalars(select(CommsMember).where(
            CommsMember.conversation_id == room.id, CommsMember.user_id == first.author,
        )):
            db.delete(member)
        db.commit()
    assert search(admin, q="starfruit")["items"] == []
    assert message_ids(search(reader, q="starfruit")) == [sent["id"]]
