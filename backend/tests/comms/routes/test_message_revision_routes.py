"""S22 revision-read authorization, activated from the preserved S17 parked test."""

import pytest

from tests.comms.routes.message_support import _edit, _error, _ok, _payload, _root

pytestmark = pytest.mark.integration


def test_revision_reads_require_author_or_current_manager(message_routes):
    case, org = message_routes, message_routes.world.first
    case.add_home_members(case.world.second.author)
    author = case.client(org.peer, org.id)
    reader = case.client(case.world.second.author, org.id)
    manager = case.client(org.author, org.id)
    path = f"{_root(org.conversation)}/messages"
    message = _ok(author.post(path, json=_payload()), 201)
    location = f"{path}/{message['id']}"
    _ok(author.patch(location, json=_edit()))
    _error(reader.get(f"{location}/revisions"), 403, "comms_capability_denied")
    assert _ok(author.get(f"{location}/revisions"))["pagination"]["total"] == 1
    assert _ok(manager.get(f"{location}/revisions"))["pagination"]["total"] == 1
    _ok(author.delete(location))
    _error(author.get(f"{location}/revisions"), 404, "comms_not_found")
