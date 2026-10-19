"""D36 delta; existing card/PII/avatar route tests stay intact."""

import pytest
from fastapi import HTTPException
from sqlalchemy import event

from app.systems.access.users.person_visibility import visible_person, visible_person_ids
from app.systems.boards.models import Board
from tests.rbac.support import add_module, make_group_access

pytestmark = pytest.mark.integration


def hidden(db, actor, peer):
    with pytest.raises(HTTPException) as refused:
        visible_person(db, actor, peer.id)
    assert refused.value.status_code == 404
    assert visible_person_ids(db, actor, {peer.id}) == set()


def test_comms_sharing_leave_and_access_loss_are_current_not_positive_cached(policy_case):
    c, db = policy_case, policy_case.db
    hidden(db, c.actor, c.peer)
    channel = c.conversation()
    c.member(channel, c.actor)
    peer_membership = c.member(channel, c.peer)
    assert visible_person(db, c.actor, c.peer.id).id == c.peer.id
    assert visible_person_ids(db, c.actor, {c.peer.id, c.world.second.peer}) == {c.peer.id}
    peer_membership.is_deleted = True
    db.flush()
    hidden(db, c.actor, c.peer)
    peer_membership.is_deleted = False
    db.flush()
    assert visible_person(db, c.actor, c.peer.id).id == c.peer.id
    channel.is_deleted = True
    db.flush()
    hidden(db, c.actor, c.peer)
    # Distinct groups avoid the existing shared-group fallback masking this revoke.
    by_group = c.conversation(scope="groups")
    left = c.group(c.actor, name="Only actor")
    right = c.group(c.peer, name="Only peer")
    c.access(by_group, group=left)
    peer_access = c.access(by_group, group=right)
    assert visible_person(db, c.actor, c.peer.id).id == c.peer.id
    peer_access.is_deleted = True
    db.flush()
    hidden(db, c.actor, c.peer)


@pytest.mark.parametrize("fallback", ["board", "module", "group"])
def test_independent_non_comms_fallback_survives_and_is_not_assumed_absent(policy_case, fallback):
    c, db = policy_case, policy_case.db
    hidden(db, c.actor, c.peer)
    if fallback == "board":
        edge = Board(org_id=c.org.id, scope="company", name="Only sharing path")
        db.add(edge)
    elif fallback == "module":
        module = add_module(db, c.department)
        make_group_access(db, [c.actor], c.department, module, level="read")
        edge = make_group_access(db, [c.peer], c.department, module, level="read")
    else:
        edge = c.group(c.actor, c.peer, name="Only sharing path")
    db.flush()
    assert visible_person(db, c.actor, c.peer.id).id == c.peer.id
    assert visible_person_ids(db, c.actor, {c.peer.id, c.world.second.peer}) == {c.peer.id}
    edge.is_deleted = True
    db.flush()
    hidden(db, c.actor, c.peer)


def test_bounded_person_set_filters_candidates_without_per_person_policy_queries(policy_case):
    c, db = policy_case, policy_case.db
    channel = c.conversation(kind="group")
    c.member(channel, c.actor)
    peers = [c.peer, *(c.person(f"Peer {number}") for number in range(11))]
    for peer in peers:
        c.member(channel, peer)
    outsider = c.person("Eligible but unshared")
    guest = c.person("Guest viewer", role="guest")
    c.member(channel, guest)
    expected = {peer.id for peer in peers}
    assert visible_person_ids(db, guest, {c.peer.id, outsider.id}) == {c.peer.id}
    assert visible_person_ids(db, c.actor, set()) == set()
    counter = []

    def counted(_connection, _cursor, _statement, _parameters, _context, _many):
        counter.append(1)  # Counts only; SQL and parameter values are not retained.

    bind = db.get_bind()
    event.listen(bind, "before_cursor_execute", counted)
    try:
        first = {peers[0].id, peers[1].id}
        assert visible_person_ids(db, c.actor, first) == first
        small_count = len(counter)
        counter.clear()
        candidates = expected | {outsider.id, c.world.second.peer}
        assert visible_person_ids(db, c.actor, candidates) == expected
        large_count = len(counter)
    finally:
        event.remove(bind, "before_cursor_execute", counted)
    # Structural batching requirement, not SQL text, exact query order, or wall-clock timing.
    assert small_count > 0
    assert large_count <= small_count + 2
    # Absolute budget is independent of either observed count: even the larger
    # candidate set must fit eight round trips, never one authorization per person.
    assert small_count <= 8
    assert large_count <= 8
    peers[0].status = "disabled"
    db.flush()
    hidden(db, c.actor, peers[0])
    c.actor.status = "disabled"
    db.flush()
    assert visible_person_ids(db, c.actor, {c.peer.id}) == set()
