"""S17 message-route journeys against the actual application; no product stubs.

Missing registration is not evidence about query growth or timing.
"""

import re
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from time import perf_counter
from uuid import UUID

import pytest
from sqlalchemy import event, select

from app.core.database.session import AuditSession
from app.systems.access.users.models import Membership, User
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.messages.models import CommsMessage, CommsMessageRevision
from app.systems.comms.settings.models import CommsSettingLock, CommsSettings
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY
from tests.comms.conftest import NOW
from tests.comms.routes.message_support import (
    IDENTITY_KEYS,
    _bootstrap,
    _edit,
    _error,
    _etag,
    _live,
    _ok,
    _payload,
    _record_performance,
    _root,
    _timestamp,
    _tombstone,
    _unread,
)
from tests.race_support import WAIT, backend_pid, wait_until_blocked_by
from tests.relationships_integration.test_statement_budgets import _statements

pytestmark = pytest.mark.integration


def test_bootstrap_is_complete_body_free_personal_and_flat_across_conversations(
    message_routes,
    record_property,
):
    case, org = message_routes, message_routes.world.first
    case.seed_roots()
    case.seed_read_state(org.peer, 1)
    peer = case.client(org.peer, org.id)
    counts, samples, statements = {}, {}, []

    def record_select(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith(("SELECT", "WITH")):
            statements.append(statement)  # No parameters or private message values retained.

    event.listen(case.world.runtime, "before_cursor_execute", record_select)
    try:
        expected = {str(org.conversation), str(org.other_conversation)}
        for size in (2, 50):
            if size == 50:
                expected.update(str(identity) for identity in case.seed_more_conversations(48))
            counts[size], samples[size] = [], []
            for _ in range(30):
                statements.clear()
                started = perf_counter()
                summaries = _bootstrap(peer, org.id, org.peer)
                samples[size].append((perf_counter() - started) * 1000)
                counts[size].append(len(statements))
                assert set(summaries) == expected
                assert all(
                    (row["conversation"]["kind"], row["conversation"]["scope"])
                    == ("channel", "organization")
                    for row in summaries.values()
                )
                assert _unread(summaries[str(org.conversation)]) == (1, 3, 2, 1, 2)
                assert all(
                    _unread(row) == (0, 0, 0, 0, None)
                    for identity, row in summaries.items()
                    if identity != str(org.conversation)
                )
                assert not any(re.search(r"\bbody(?:_tsv)?\b", sql) for sql in statements)
    finally:
        event.remove(case.world.runtime, "before_cursor_execute", record_select)
    assert min(counts[2]) > 0
    assert set(counts[2][1:]) == set(counts[50][1:])
    assert len(set(counts[2][1:])) == 1
    for size in (2, 50):
        record_property(f"bootstrap_{size}_select_counts", counts[size])
        record_property(f"bootstrap_{size}_request_ms", samples[size])
        record_property(f"bootstrap_{size}_request_p95_ms", sorted(samples[size])[28])
        _record_performance(f"bootstrap-{size}", samples[size], counts[size])


def test_send_replays_the_current_edited_or_deleted_resource_without_message_preconditions(
    message_routes,
):
    case, org = message_routes, message_routes.world.first
    api = case.client(org.author, org.id)
    path = f"{_root(org.conversation)}/messages"
    original = _payload()
    created = api.post(path, json=original)
    first = _ok(created, 201)
    _live(first, org.id, org.conversation, org.author, original)
    assert first["seq"] == 1 and first["edited_at"] is None and first["thread"] is None
    location = f"{path}/{first['id']}"
    assert created.headers["location"] == location
    current = api.get(location)
    assert _ok(current) == first
    old_etag = _etag(current)
    assert _ok(api.post(path, json=original)) == first

    edit_body = _edit()
    edited_response = api.patch(location, json=edit_body)
    edited = _ok(edited_response)
    _live(edited, org.id, org.conversation, org.author, {**original, "body": edit_body["body"]})
    assert edited["id"] == first["id"] and edited["seq"] == 1
    _timestamp(edited["edited_at"])
    current = api.get(location)
    assert _ok(current) == edited
    assert _etag(current) != old_etag
    assert _ok(api.post(path, json=original)) == edited
    _error(
        api.post(path, json={**original, "body": "Different original payload"}),
        409,
        "comms_idempotency_mismatch",
    )
    with case.world.session(org) as db:
        revisions = db.scalars(
            select(CommsMessageRevision.body).where(
                CommsMessageRevision.org_id == org.id,
                CommsMessageRevision.message_id == UUID(first["id"]),
            )
        ).all()
        assert revisions == [original["body"]]

    deleted = _ok(api.delete(location))
    _tombstone(deleted)
    assert {key: deleted[key] for key in IDENTITY_KEYS} == {
        key: first[key] for key in IDENTITY_KEYS
    }
    assert _ok(api.get(location)) == deleted
    assert _ok(api.get(f"{path}/by-sequence/1")) == deleted
    assert _ok(api.post(path, json=original)) == deleted
    history = _ok(api.get(path))
    assert history["items"] == [deleted]
    assert history["pagination"]["high_water_seq"] == 1


def test_sparse_timeline_has_exclusive_cursors_and_flat_page_queries(message_routes):
    case, org = message_routes, message_routes.world.first
    ids = case.seed_timeline()
    api = case.client(org.peer, org.id)
    path = f"{_root(org.conversation)}/messages"
    for query, expected, older, newer in (
        ({"limit": 2}, [7, 9], True, False),
        ({"limit": 2, "before_seq": 7}, [1, 3], False, True),
        ({"limit": 2, "after_seq": 3}, [7, 9], True, False),
        ({"limit": 3, "around_seq": 7}, [3, 7, 9], True, False),
        ({"limit": 2, "around_seq": 1}, [1, 3], False, True),
        ({"limit": 2, "around_seq": 99}, [7, 9], True, False),
    ):
        page = _ok(api.get(path, params=query))
        assert set(page) == {"org_id", "conversation_id", "thread_root_id", "items", "pagination"}
        assert (page["org_id"], page["conversation_id"], page["thread_root_id"]) == (
            str(org.id),
            str(org.conversation),
            None,
        )
        assert [(item["seq"], item["id"]) for item in page["items"]] == [
            (seq, str(ids[seq])) for seq in expected
        ]
        assert page["pagination"] == {
            "limit": query["limit"],
            "count": len(expected),
            "first_seq": expected[0],
            "last_seq": expected[-1],
            "high_water_seq": 12,
            "has_older": older,
            "has_newer": newer,
        }
    counts = []
    # Both sizes include a live root with thread metadata and populated mentions;
    # an optional enrichment query appearing only in the larger page is not N+1.
    for limit, expected in ((1, [1]), (4, [1, 3, 7, 9])):
        with _statements(case.world.runtime) as statements:
            page = _ok(api.get(path, params={"limit": limit, "after_seq": 0}))
        counts.append(len(statements))
        assert [item["seq"] for item in page["items"]] == expected
        for item in page["items"]:
            if item["seq"] == 7:
                _tombstone(item)  # Stored body/mention must not escape the tombstone.
            else:
                assert item["mention_user_ids"] == [str(org.peer)]
    assert counts[0] > 0 and counts[0] == counts[1], counts
    exact = _ok(api.get(f"{path}/by-sequence/12"))
    assert (exact["id"], exact["parent_id"], exact["also_send_to_channel"]) == (
        str(ids[12]),
        str(ids[1]),
        False,
    )
    empty = _ok(api.get(path, params={"after_seq": 9}))
    assert empty["items"] == []
    assert [
        empty["pagination"][key]
        for key in (
            "count",
            "first_seq",
            "last_seq",
            "high_water_seq",
        )
    ] == [0, None, None, 12]
    assert empty["pagination"]["has_older"] is True
    assert empty["pagination"]["has_newer"] is False
    before_first = _ok(api.get(path, params={"before_seq": 1}))
    assert before_first["items"] == []
    assert [
        before_first["pagination"][key]
        for key in (
            "count",
            "first_seq",
            "last_seq",
            "high_water_seq",
            "has_older",
            "has_newer",
        )
    ] == [0, None, None, 12, False, True]
    assert api.get(path, params={"before_seq": 7, "after_seq": 3}).status_code == 422


@pytest.mark.parametrize(
    "query",
    [
        {"limit": 0},
        {"limit": 101},
        {"after_seq": -1},
        {"before_seq": 0},
        {"around_seq": 9007199254740992},
        {"offset": 1},
    ],
)
def test_history_rejects_invalid_or_offset_pagination(message_routes, query):
    case, org = message_routes, message_routes.world.first
    response = case.client(org.peer, org.id).get(
        f"{_root(org.conversation)}/messages",
        params=query,
    )
    assert response.status_code == 422


def test_history_reads_a_bounded_page_from_one_hundred_thousand_messages(
    message_routes,
    record_property,
):
    case, org = message_routes, message_routes.world.first
    expected = case.seed_large_history()
    api, path = case.client(org.peer, org.id), f"{_root(org.conversation)}/messages"
    selects, body_rows, timings, counts = [], [], [], []

    def record_select(_connection, cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith(("SELECT", "WITH")):
            selects.append(statement)
            if re.search(r"\bbody\b", statement):
                body_rows.append(cursor.rowcount)

    event.listen(case.world.runtime, "after_cursor_execute", record_select)
    try:
        for limit in (2, 50):
            selects.clear()
            page = _ok(api.get(path, params={"limit": limit}))
            counts.append(len(selects))
            assert [row["seq"] for row in page["items"]] == list(range(100_001 - limit, 100_001))
            assert [row["id"] for row in page["items"]] == [
                str(expected[seq]) for seq in range(100_001 - limit, 100_001)
            ]
        for _ in range(30):
            started = perf_counter()
            page = _ok(api.get(path, params={"limit": 50}))
            timings.append((perf_counter() - started) * 1000)
            assert page["pagination"]["high_water_seq"] == 100_000
            assert page["pagination"]["count"] == 50
    finally:
        event.remove(case.world.runtime, "after_cursor_execute", record_select)
    assert counts[0] > 0 and counts[0] == counts[1]
    assert body_rows and all(0 <= count <= 50 for count in body_rows)
    record_property("history_100000_select_counts", counts)
    record_property("history_100000_request_ms", timings)
    record_property("history_100000_request_p95_ms", sorted(timings)[28])
    _record_performance("history-100000", timings, counts)


def test_routes_recheck_hidden_foreign_guest_and_current_membership_boundaries(message_routes):
    case, home, visited = message_routes, message_routes.world.first, message_routes.world.second
    case.hide_other_conversation()
    case.add_visited_guest()
    peer = case.client(home.peer, home.id)
    owner = case.client(home.author, home.id)
    neighbour = case.client(visited.author, visited.id)
    path = f"{_root(home.conversation)}/messages"
    original = _payload("Peer's committed message")
    own = _ok(peer.post(path, json=original), 201)
    assert _ok(peer.get(path))["items"] == [own]
    hidden_path = f"{_root(home.other_conversation)}/messages"
    hidden = _ok(owner.post(hidden_path, json=_payload("Hidden content")), 201)
    foreign_path = f"{_root(visited.conversation)}/messages"
    foreign = _ok(neighbour.post(foreign_path, json=_payload("Foreign content")), 201)
    for target, message in ((hidden_path, hidden), (foreign_path, foreign)):
        _error(peer.get(target), 404, "comms_not_found")
        _error(peer.get(f"{target}/{message['id']}"), 404, "comms_not_found")
        _error(peer.post(target, json=_payload("Not permitted")), 404, "comms_not_found")
    # Same account: admin at home, guest in visited. Real header resolution, not a
    # prebound org/current-membership override, determines the authority here.
    _error(owner.get(foreign_path), 404, "comms_not_found")
    visited_headers = {"X-Org": str(visited.id)}
    assert _ok(owner.get(foreign_path, headers=visited_headers))["items"] == [foreign]
    assert _ok(
        owner.put(
            f"{_root(visited.conversation)}/read",
            headers=visited_headers,
            json={"last_read_seq": 1},
        )
    ) == {
        "conversation_id": str(visited.conversation),
        "last_read_seq": 1,
    }
    _error(
        owner.post(foreign_path, headers=visited_headers, json=_payload("Guest cannot post")),
        403,
        "comms_post_denied",
    )
    case.revoke_peer_membership()
    _error(peer.get(path), 403, "organization_required")
    _error(peer.post(path, json=original), 403, "organization_required")
    _error(peer.get("/api/comms/bootstrap"), 403, "organization_required")
    assert _ok(owner.get(path))["items"] == [own]
    assert _ok(owner.get(hidden_path))["items"] == [hidden]
    assert _ok(neighbour.get(foreign_path))["items"] == [foreign]


def test_read_is_monotone_clears_reminder_and_only_changes_current_user(message_routes):
    case, org = message_routes, message_routes.world.first
    case.seed_roots()
    case.seed_read_state(org.peer, 0, manual_unread=True)
    case.seed_read_state(org.author, 0)
    peer, author = case.client(org.peer, org.id), case.client(org.author, org.id)
    path = f"{_root(org.conversation)}/read"
    before = _bootstrap(peer, org.id, org.peer)[str(org.conversation)]
    assert _unread(before) == (0, 3, 3, 1, 1)
    assert before["preferences"]["manual_unread"] is True
    assert peer.put(path, json={"last_read_seq": 2, "user_id": str(org.author)}).status_code == 422
    assert _unread(_bootstrap(peer, org.id, org.peer)[str(org.conversation)]) == (0, 3, 3, 1, 1)
    assert _bootstrap(author, org.id, org.author)[str(org.conversation)]["last_read_seq"] == 0
    for requested, expected in (
        (1, (1, 3, 2, 1, 2)),
        (3, (3, 3, 0, 0, None)),
        (2, (3, 3, 0, 0, None)),
    ):
        result = _ok(peer.put(path, json={"last_read_seq": requested}))
        assert result == {"conversation_id": str(org.conversation), "last_read_seq": expected[0]}
        summary = _bootstrap(peer, org.id, org.peer)[str(org.conversation)]
        assert _unread(summary) == expected
        assert summary["preferences"]["manual_unread"] is False
        assert _bootstrap(author, org.id, org.author)[str(org.conversation)]["last_read_seq"] == 0
    assert _ok(author.put(path, json={"last_read_seq": 2})) == {
        "conversation_id": str(org.conversation),
        "last_read_seq": 2,
    }
    assert _unread(_bootstrap(peer, org.id, org.peer)[str(org.conversation)]) == (3, 3, 0, 0, None)
    assert _ok(peer.put(path, json={"last_read_seq": 999})) == {
        "conversation_id": str(org.conversation),
        "last_read_seq": 3,
    }
    assert _unread(_bootstrap(peer, org.id, org.peer)[str(org.conversation)]) == (3, 3, 0, 0, None)
    assert _bootstrap(author, org.id, org.author)[str(org.conversation)]["last_read_seq"] == 2


def test_bootstrap_unread_counts_exclude_self_and_tombstones_and_saturate_at_100(message_routes):
    case, org = message_routes, message_routes.world.first
    case.seed_roots(101)
    peer, author = case.client(org.peer, org.id), case.client(org.author, org.id)
    assert _unread(_bootstrap(peer, org.id, org.peer)[str(org.conversation)]) == (
        0,
        101,
        100,
        1,
        1,
    )
    assert _unread(_bootstrap(author, org.id, org.author)[str(org.conversation)]) == (
        0,
        101,
        0,
        0,
        None,
    )
    with case.world.session(org) as db:
        for message in db.scalars(
            select(CommsMessage).where(
                CommsMessage.conversation_id == org.conversation,
                CommsMessage.seq.in_([1, 2]),
            )
        ):
            message.is_deleted, message.deleted_at = True, NOW
        db.commit()
    assert _unread(_bootstrap(peer, org.id, org.peer)[str(org.conversation)]) == (
        0,
        101,
        99,
        0,
        3,
    )


def test_bootstrap_names_direct_and_group_participants_who_are_visible_people(message_routes):
    case, org, home = message_routes, message_routes.world.first, message_routes.world.second
    private = case.private_conversations()
    with case.world.session(org) as db:
        db.get(User, org.peer).display_name = "Pat Peer"
        db.get(User, home.author).display_name = ""
        # D36: a person who is no longer an active member is not visible, so not named.
        db.scalars(select(Membership).where(
            Membership.org_id == org.id, Membership.user_id == home.peer,
        )).one().status = "disabled"
        db.commit()
    peer = case.client(org.peer, org.id)
    summaries = _bootstrap(peer, org.id, org.peer)
    names = {
        str(org.peer): "Pat Peer",
        str(home.author): f"person-{home.author}",
        str(home.peer): None,
    }
    for kind, count in (("direct", 2), ("group", 3)):
        identity = str(private[kind][0])
        conversation = summaries[identity]["conversation"]
        participants = conversation["participants"]
        assert [row["user_id"] for row in participants] == conversation["participant_ids"]
        assert len(participants) == count
        assert all(row == {"user_id": row["user_id"], "display_name": names[row["user_id"]]}
                   for row in participants)
        assert _ok(peer.get(f"/api/comms/conversations/{identity}")) == conversation
    assert "participants" not in summaries[str(org.conversation)]["conversation"]


def test_bootstrap_channel_thread_branches_follow_workspace_category_channel_and_locks(
    message_routes,
):
    case, org = message_routes, message_routes.world.first
    in_category, overridden = case.seed_more_conversations(2)
    case.settings({"thread_branches": "followed"})
    case.settings({"thread_branches": "all"}, overridden)
    with case.world.session(org) as db:
        db.get(CommsConversation, org.conversation).category_id = None  # Workspace layer only.
        db.add(CommsSettings(
            org_id=org.id, scope="category", category_id=org.category,
            values={"thread_branches": "none"},
        ))
        db.commit()
    peer = case.client(org.peer, org.id)

    def branches():
        summaries = _bootstrap(peer, org.id, org.peer)
        return [
            summaries[str(identity)]["conversation"]["thread_branches"]
            for identity in (org.conversation, in_category, overridden)
        ]

    assert branches() == ["followed", "none", "all"]
    with case.world.session(org) as db:
        db.add(CommsSettingLock(org_id=org.id, namespace="setting", key="thread_branches"))
        db.commit()
    assert branches() == ["followed", "followed", "followed"]
    assert _ok(peer.get(f"/api/comms/conversations/{overridden}"))["thread_branches"] == (
        "followed"
    )


def test_nonmember_admin_cannot_discover_private_direct_or_group_messages(message_routes):
    case, org = message_routes, message_routes.world.first
    private = case.private_conversations()
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    hidden = {str(conversation) for conversation, _ in private.values()}
    response = admin.get("/api/comms/bootstrap")
    assert hidden.isdisjoint(row["conversation"]["id"] for row in _ok(response)["conversations"])
    for kind in private:
        assert f"Private {kind} content" not in response.text
    visible = _bootstrap(peer, org.id, org.peer)
    assert hidden <= visible.keys()
    for conversation, message in private.values():
        path = f"{_root(conversation)}/messages"
        for target in (path, f"{path}/{message}", f"{path}/by-sequence/1"):
            _error(admin.get(target), 404, "comms_not_found")
        assert _ok(peer.get(f"{path}/{message}"))["id"] == str(message)
        _error(
            admin.put(f"{_root(conversation)}/read", json={"last_read_seq": 1}),
            404,
            "comms_not_found",
        )


def test_every_message_family_route_requires_authentication(message_routes):
    case, org = message_routes, message_routes.world.first
    api = case.anonymous_client(org.id)
    path = f"{_root(org.conversation)}/messages"
    item = f"{path}/00000000-0000-4000-8000-000000000001"
    for method, target, options in (
        ("GET", "/api/comms/bootstrap", {}),
        ("GET", path, {}),
        ("POST", path, {"json": _payload()}),
        ("GET", item, {}),
        ("GET", f"{path}/by-sequence/1", {}),
        ("PATCH", item, {"json": _edit()}),
        ("DELETE", item, {}),
        ("PUT", f"{_root(org.conversation)}/read", {"json": {"last_read_seq": 0}}),
    ):
        assert api.request(method, target, **options).status_code == 401


def test_competing_first_read_watermarks_converge_without_lost_updates(message_routes):
    case, org = message_routes, message_routes.world.first
    case.seed_roots()
    api, path = case.client(org.peer, org.id), f"{_root(org.conversation)}/read"
    held, release, holder = Event(), Event(), []

    def pause_commit(session):
        context = session.info.get(AUDIT_CONTEXT_KEY)
        if session.get_bind() is not case.world.runtime or context is None or held.is_set():
            return
        if context.request_method != "PUT" or context.request_path != path:
            return
        session.flush()
        holder.append(backend_pid(session))
        held.set()
        assert release.wait(WAIT)

    event.listen(AuditSession, "before_commit", pause_commit)
    try:
        with ThreadPoolExecutor(max_workers=2) as workers:
            first = workers.submit(api.put, path, json={"last_read_seq": 3})
            try:
                assert held.wait(WAIT)
                second = workers.submit(api.put, path, json={"last_read_seq": 1})
                assert wait_until_blocked_by(case.world.owner, holder[0]) != holder[0]
            finally:
                release.set()
            assert _ok(first.result(timeout=WAIT))["last_read_seq"] == 3
            assert _ok(second.result(timeout=WAIT))["last_read_seq"] == 3
    finally:
        release.set()
        event.remove(AuditSession, "before_commit", pause_commit)
    assert _unread(_bootstrap(api, org.id, org.peer)[str(org.conversation)]) == (3, 3, 0, 0, None)
