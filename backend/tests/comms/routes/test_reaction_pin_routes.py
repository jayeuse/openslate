"""Reaction and pin projections remain current, personal and bound to readable live messages."""

from uuid import UUID

import pytest
from sqlalchemy import select

from app.systems.comms.messages.interaction_models import CommsReaction
from tests.comms.routes.message_support import send
from tests.comms.routes.structure_support import ROOT, _error, _ok

pytestmark = pytest.mark.integration


def test_reactions_hard_delete_and_pins_use_current_capabilities_and_settings(message_routes):
    case, org = message_routes, message_routes.world.first
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    c = f"{ROOT}/conversations/{org.conversation}"
    row = send(peer, c + "/messages")
    path = c + "/messages/" + row["id"]
    for method, expected in (("POST", True), ("DELETE", False), ("POST", True)):
        result = _ok(peer.request(method, path + "/reactions", json={"emoji": "👍"}))
        assert result["reactions"] == (
            [{"emoji": "👍", "user_ids": [str(org.peer)]}] if expected else []
        )
        if not expected:
            with case.world.session(org) as db:
                assert (
                    db.scalars(
                        select(CommsReaction.id).where(CommsReaction.message_id == UUID(row["id"]))
                    ).all()
                    == []
                )
    _error(peer.post(path + "/reactions", json={"emoji": "unconfigured"}), 422)
    _error(peer.post(path + "/reactions", json={"emoji": "👍", "user_id": str(org.author)}), 422)
    _error(peer.put(path + "/pin", json={"pinned": True}), 403)
    pinned = _ok(admin.put(path + "/pin", json={"pinned": True}))
    assert pinned["pinned_by"] == str(org.author) and pinned["pinned_at"]
    assert [item["id"] for item in _ok(peer.get(c + "/pins"))["items"]] == [row["id"]]
    unpinned = _ok(admin.put(path + "/pin", json={"pinned": False}))
    assert unpinned["pinned_at"] is None and unpinned["pinned_by"] is None
    assert _ok(peer.get(c + "/pins"))["pagination"]["total"] == 0
    _ok(admin.put(path + "/pin", json={"pinned": True}))
    _ok(peer.delete(path))
    assert _ok(admin.get(c + "/pins"))["items"] == []
    _error(admin.post(path + "/reactions", json={"emoji": "👍"}), 404)
    _error(admin.put(path + "/pin", json={"pinned": True}), 404)
    case.add_visited_guest()
    outsider = case.client(org.author, case.world.second.id)
    _error(outsider.get(c + "/pins"), 404)
    _error(outsider.post(path + "/reactions", json={"emoji": "👍"}), 404)
