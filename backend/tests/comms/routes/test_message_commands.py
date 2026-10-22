"""Message admission and mutation rules through the actual HTTP boundary."""

import json
from datetime import timedelta
from uuid import UUID

import pytest
from sqlalchemy import select

from app.systems.comms.conversations.models import CommsConversation, CommsDirectBlock
from app.systems.comms.messages.models import CommsMessageRevision
from tests.comms.conftest import NOW
from tests.comms.routes.message_support import (
    _edit,
    _error,
    _live,
    _ok,
    _payload,
    _root,
    _tombstone,
)
from tests.comms.test_message_transactions import _stored_state

pytestmark = pytest.mark.integration
REFERENCE = "00000000-0000-4000-8000-000000000001"


@pytest.mark.parametrize(
    "changes",
    [
        {"body": ""},
        {"body": " \n\t"},
        {"body": "\u0000"},
        {"body": "🪁" * 4001},
        {"author_id": REFERENCE},
        {"org_id": REFERENCE},
        {"parent_id": REFERENCE},
        {"attachment_ids": [REFERENCE]},
        {"record_ids": [REFERENCE]},
        {"mentions_channel": "true"},
        {"client_key": "not-a-uuid"},
    ],
)
def test_invalid_message_input_is_422_without_committed_side_effects(message_routes, changes):
    case, org = message_routes, message_routes.world.first
    api = case.client(org.peer, org.id)
    before = _stored_state(case.world)
    response = api.post(f"{_root(org.conversation)}/messages", json=_payload() | changes)
    assert response.status_code == 422
    assert _stored_state(case.world) == before


def test_send_preserves_four_thousand_unicode_code_points(message_routes):
    case, org = message_routes, message_routes.world.first
    payload = _payload("🪁" * 4000)
    response = case.client(org.peer, org.id).post(
        f"{_root(org.conversation)}/messages",
        json=payload,
    )
    _live(_ok(response, 201), org.id, org.conversation, org.peer, payload)


def test_invalid_unicode_body_is_refused_before_database_write(message_routes):
    case, org = message_routes, message_routes.world.first
    before = _stored_state(case.world)
    encoded = json.dumps(_payload("\ud800"), ensure_ascii=True).encode("ascii")
    response = case.client(org.peer, org.id).post(
        f"{_root(org.conversation)}/messages",
        content=encoded,
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert _stored_state(case.world) == before


@pytest.mark.parametrize(
    "restriction", ["archived", "locked", "restricted", "announcements", "thread-first"]
)
def test_new_send_policy_does_not_erase_readable_replay(message_routes, budget_clock, restriction):
    case, org = message_routes, message_routes.world.first
    api, path = case.client(org.peer, org.id), f"{_root(org.conversation)}/messages"
    payload = _payload()
    original = _ok(api.post(path, json=payload), 201)
    if restriction == "archived":
        with case.world.session(org) as db:
            conversation = db.get(CommsConversation, org.conversation)
            conversation.archived_at = NOW
            db.commit()
    else:
        values = (
            {"locked": True}
            if restriction == "locked"
            else {
                "restricted_person_ids": [str(org.peer)],
                "restriction_until": None,
            }
            if restriction == "restricted"
            else {"mode": restriction}
        )
        case.settings(values)
    before = _stored_state(case.world)
    _error(api.post(path, json=_payload("New send refused")), 403, "comms_post_denied")
    assert _ok(api.post(path, json=payload)) == original
    assert _ok(api.get(f"{path}/{original['id']}")) == original
    assert _stored_state(case.world) == before


def test_expired_posting_restriction_allows_a_new_send(message_routes, budget_clock):
    case, org = message_routes, message_routes.world.first
    case.settings(
        {
            "restricted_person_ids": [str(org.peer)],
            "restriction_until": (NOW - timedelta(seconds=1)).isoformat(),
        }
    )
    response = case.client(org.peer, org.id).post(
        f"{_root(org.conversation)}/messages",
        json=_payload(),
    )
    assert response.status_code == 201


def test_slow_mode_uses_committed_send_time_without_blocking_replay(message_routes, budget_clock):
    case, org = message_routes, message_routes.world.first
    case.settings({"slow_mode_seconds": 10})
    api, path = case.client(org.peer, org.id), f"{_root(org.conversation)}/messages"
    payload = _payload()
    first = _ok(api.post(path, json=payload), 201)
    for seconds, retry in ((0, "10"), (9.2, "1")):
        budget_clock[0] = NOW + timedelta(seconds=seconds)
        refused = api.post(path, json=_payload())
        _error(refused, 429, "comms_slow_mode")
        assert refused.headers["retry-after"] == retry
        assert _ok(api.post(path, json=payload)) == first
    budget_clock[0] = NOW + timedelta(seconds=10)
    assert _ok(api.post(path, json=_payload()), 201)["seq"] == 2


@pytest.mark.parametrize("method", ["PATCH", "DELETE"])
def test_message_change_windows_use_original_creation_time_and_zero_is_unlimited(
    message_routes,
    budget_clock,
    method,
):
    case, org = message_routes, message_routes.world.first
    case.settings({"edit_window_minutes": 1, "delete_window_minutes": 1})
    api, path = case.client(org.peer, org.id), f"{_root(org.conversation)}/messages"
    first = _ok(api.post(path, json=_payload()), 201)
    second = _ok(api.post(path, json=_payload()), 201)
    options = {"json": _edit()} if method == "PATCH" else {}
    budget_clock[0] = NOW + timedelta(minutes=1)
    assert api.request(method, f"{path}/{first['id']}", **options).status_code == 200
    budget_clock[0] += timedelta(microseconds=1)
    before = _stored_state(case.world)
    _error(api.request(method, f"{path}/{second['id']}", **options), 403, "comms_post_denied")
    if method == "PATCH":
        _error(
            api.patch(f"{path}/{first['id']}", json=_edit("Later edit")), 403, "comms_post_denied"
        )
    assert _stored_state(case.world) == before
    case.settings({"edit_window_minutes": 0, "delete_window_minutes": 0})
    budget_clock[0] = NOW + timedelta(days=1)
    assert api.request(method, f"{path}/{second['id']}", **options).status_code == 200


def test_edits_append_revisions_without_requiring_or_comparing_if_match(
    message_routes, budget_clock
):
    case, org = message_routes, message_routes.world.first
    api, path = case.client(org.peer, org.id), f"{_root(org.conversation)}/messages"
    original = _ok(api.post(path, json=_payload("Original")), 201)
    location = f"{path}/{original['id']}"
    for body, headers in (("First edit", {}), ("Second edit", {"If-Match": '"obsolete"'})):
        budget_clock[0] += timedelta(seconds=1)
        edited = _ok(api.patch(location, json=_edit(body), headers=headers))
        assert edited["body"] == body and edited["edited_at"] is not None
    with case.world.session(org) as db:
        stored = db.scalars(
            select(CommsMessageRevision)
            .where(
                CommsMessageRevision.message_id == UUID(original["id"]),
            )
            .order_by(CommsMessageRevision.created_at, CommsMessageRevision.id)
        ).all()
        assert len(stored) == 2
        assert [row.body for row in stored] == ["Original", "First edit"]
        assert {row.author_id for row in stored} == {org.peer}
    _tombstone(_ok(api.delete(location, headers={"If-Match": '"obsolete"'})))


@pytest.mark.parametrize("channel_flag", ["mentions_channel", "mentions_here"])
def test_mentions_need_current_readers_capability_and_the_configured_limit(
    message_routes,
    channel_flag,
):
    case, org = message_routes, message_routes.world.first
    peer, manager = case.client(org.peer, org.id), case.client(org.author, org.id)
    path = f"{_root(org.conversation)}/messages"
    before = _stored_state(case.world)
    # Another organization's person can never read this channel; D44 reader cases are owned by
    # test_channel_readers_without_member_rows_are_mentionable_and_notified.
    invalid = _payload() | {"mention_user_ids": [str(case.world.second.author)]}
    assert peer.post(path, json=invalid).status_code == 422
    assert _stored_state(case.world) == before
    valid = _payload() | {"mention_user_ids": [str(org.author)]}
    assert _ok(peer.post(path, json=valid), 201)["mention_user_ids"] == [str(org.author)]
    _error(peer.post(path, json=_payload() | {channel_flag: True}), 403, "comms_capability_denied")
    assert (
        _ok(manager.post(path, json=_payload() | {channel_flag: True}), 201)[channel_flag] is True
    )
    case.settings({"mention_limit": 1})
    before = _stored_state(case.world)
    excessive = _payload() | {"mention_user_ids": [str(org.peer)], channel_flag: True}
    assert manager.post(path, json=excessive).status_code == 422
    assert _stored_state(case.world) == before


def test_managers_cannot_edit_other_authors_but_can_delete_without_the_own_window(
    message_routes,
    budget_clock,
):
    case, org = message_routes, message_routes.world.first
    case.settings({"edit_window_minutes": 1, "delete_window_minutes": 1})
    peer, manager = case.client(org.peer, org.id), case.client(org.author, org.id)
    path = f"{_root(org.conversation)}/messages"
    message = _ok(peer.post(path, json=_payload()), 201)
    location = f"{path}/{message['id']}"
    budget_clock[0] += timedelta(minutes=2)
    _error(manager.patch(location, json=_edit()), 403, "comms_post_denied")
    _error(peer.delete(location), 403, "comms_post_denied")
    _tombstone(_ok(manager.delete(location)))


def test_conversation_access_loss_refuses_get_edit_delete_read_and_replay(message_routes):
    case, org = message_routes, message_routes.world.first
    peer = case.client(org.peer, org.id)
    path = f"{_root(org.other_conversation)}/messages"
    payload = _payload()
    message = _ok(peer.post(path, json=payload), 201)
    case.hide_other_conversation()
    location = f"{path}/{message['id']}"
    before = _stored_state(case.world)
    for response in (
        peer.get(location),
        peer.patch(location, json=_edit()),
        peer.delete(location),
        peer.post(path, json=payload),
        peer.put(f"{_root(org.other_conversation)}/read", json={"last_read_seq": 1}),
    ):
        _error(response, 404, "comms_not_found")
    assert _stored_state(case.world) == before


def test_direct_block_refuses_content_changes_neutrally_but_preserves_readable_replay(
    message_routes,
):
    case, org = message_routes, message_routes.world.first
    conversation, _ = case.private_conversations()["direct"]
    peer = case.client(org.peer, org.id)
    path = f"{_root(conversation)}/messages"
    payload = _payload()
    original = _ok(peer.post(path, json=payload), 201)
    with case.world.session(org) as db:
        db.add(
            CommsDirectBlock(
                org_id=org.id,
                user_id=case.world.second.author,
                blocked_user_id=org.peer,
            )
        )
        db.commit()
    before = _stored_state(case.world)
    for method, target, options in (
        ("POST", path, {"json": _payload()}),
        ("PATCH", f"{path}/{original['id']}", {"json": _edit()}),
        ("DELETE", f"{path}/{original['id']}", {}),
    ):
        refused = peer.request(method, target, **options)
        _error(refused, 403, "comms_post_denied")
        assert "blocked" not in refused.text.lower()
    assert _ok(peer.post(path, json=payload)) == original
    assert _stored_state(case.world) == before
