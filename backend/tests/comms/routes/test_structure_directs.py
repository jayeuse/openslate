"""Direct identity races and organization-local private block lifetimes."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier, Event
from uuid import UUID

import pytest
from sqlalchemy import event, select

from app.core.database.session import AuditSession
from app.systems.comms.conversations.models import CommsConversation, CommsDirectBlock, CommsMember
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY
from tests.comms.conftest import NOW
from tests.comms.routes.structure_support import ROOT, _error, _ok, _race, _read, _snapshot, _tag
from tests.race_support import WAIT

pytestmark = pytest.mark.integration


def test_reciprocal_direct_creation_converges_across_archive_and_block_lifetime(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    gate = Barrier(2)
    left, right = (
        case.client(org.author, org.id, request_gate=gate),
        case.client(
            org.peer,
            org.id,
            request_gate=gate,
        ),
    )
    directs = f"{ROOT}/directs"
    outcomes = _race(
        lambda: left.post(directs, json={"recipient_id": str(org.peer)}),
        lambda: right.post(directs, json={"recipient_id": str(org.author)}),
    )
    assert sorted(row.status_code for row in outcomes) == [200, 201]
    identity = outcomes[0].json()["id"]
    path = f"{ROOT}/conversations/{identity}"
    for response in outcomes:
        row = response.json()
        assert row["id"] == identity and row["kind"] == "direct" and row["org_id"] == str(org.id)
        assert set(row["participant_ids"]) == {str(org.author), str(org.peer)}
        _tag(response)
        if response.status_code == 201:
            assert response.headers["location"] == path
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    archived = _ok(admin.post(path + "/archive", headers={"If-Match": _tag(_read(admin, path))}))
    assert archived["archived_at"] is not None
    assert _ok(peer.post(directs, json={"recipient_id": str(org.author)}))["id"] == identity
    assert (
        _ok(admin.post(path + "/restore", headers={"If-Match": _tag(_read(admin, path))}))[
            "archived_at"
        ]
        is None
    )
    for _ in range(2):
        on = peer.post(ROOT + "/direct-blocks", json={"blocked_user_id": str(org.author)})
        assert on.status_code == 204 and on.content == b""
        assert [
            row["blocked_user_id"] for row in _ok(peer.get(ROOT + "/direct-blocks"))["items"]
        ] == [str(org.author)]
        assert _ok(admin.get(ROOT + "/direct-blocks"))["items"] == []
        refused = admin.post(directs, json={"recipient_id": str(org.peer)})
        _error(refused, 403, "comms_post_denied")
        assert "blocked" not in refused.text.lower()
        assert _ok(admin.get(path))["id"] == identity
        off = peer.delete(f"{ROOT}/direct-blocks/{org.author}")
        assert off.status_code == 204 and off.content == b""
        with case.world.session(org) as db:
            assert (
                db.scalars(
                    select(CommsDirectBlock.id).where(
                        CommsDirectBlock.org_id == org.id,
                        CommsDirectBlock.user_id == org.peer,
                        CommsDirectBlock.blocked_user_id == org.author,
                    )
                ).all()
                == []
            )  # Off removes the row, not just its active flag.
        assert _ok(admin.post(directs, json={"recipient_id": str(org.peer)}))["id"] == identity
    with case.world.session(org) as db:
        rows = db.scalars(
            select(CommsConversation).where(
                CommsConversation.org_id == org.id,
                CommsConversation.kind == "direct",
            )
        ).all()
        assert [row.id for row in rows] == [UUID(identity)]
        assert rows[0].direct_key == ":".join(sorted((str(org.author), str(org.peer))))
        assert set(
            db.execute(
                select(CommsMember.user_id, CommsMember.is_deleted).where(
                    CommsMember.org_id == org.id,
                    CommsMember.conversation_id == UUID(identity),
                )
            )
        ) == {(org.author, False), (org.peer, False)}
    before = _snapshot(case)
    _error(admin.post(directs, json={"recipient_id": str(org.author)}), 422)
    _error(
        admin.post(directs, json={"recipient_id": str(case.world.second.author)}),
        404,
        "comms_not_found",
    )
    assert _snapshot(case) == before
    case.add_visited_guest()
    guest = case.client(org.author, case.world.second.id)
    _error(guest.post(directs, json={"recipient_id": str(case.world.second.author)}), 403)
    assert _ok(guest.get(ROOT + "/direct-blocks"))["items"] == []


def test_blocks_filter_actor_and_org_before_offset_pages(structure_routes):
    case, org, other = structure_routes, structure_routes.world.first, structure_routes.world.second
    case.add_home_members(other.author)
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    for target in (org.peer, other.author):
        assert (
            admin.post(ROOT + "/direct-blocks", json={"blocked_user_id": str(target)}).status_code
            == 204
        )
    assert (
        peer.post(ROOT + "/direct-blocks", json={"blocked_user_id": str(org.author)}).status_code
        == 204
    )
    with case.world.session(org) as db:
        for target, instant in ((org.peer, NOW), (other.author, NOW + timedelta(seconds=1))):
            row = db.scalar(
                select(CommsDirectBlock).where(
                    CommsDirectBlock.org_id == org.id,
                    CommsDirectBlock.user_id == org.author,
                    CommsDirectBlock.blocked_user_id == target,
                )
            )
            row.created_at = instant
        db.commit()
    query = {"sort_by": "created_at", "sort_order": "asc", "limit": 1}
    first = _ok(admin.get(ROOT + "/direct-blocks", params=query))
    last = _ok(admin.get(ROOT + "/direct-blocks", params=query | {"offset": 1}))
    assert [r["blocked_user_id"] for r in first["items"]] == [str(org.peer)]
    assert [r["blocked_user_id"] for r in last["items"]] == [str(other.author)]
    assert first["pagination"] == {
        "limit": 1,
        "offset": 0,
        "count": 1,
        "total": 2,
        "has_more": True,
    }
    assert last["pagination"] == {
        "limit": 1,
        "offset": 1,
        "count": 1,
        "total": 2,
        "has_more": False,
    }
    assert [r["blocked_user_id"] for r in _ok(peer.get(ROOT + "/direct-blocks"))["items"]] == [
        str(org.author)
    ]
    case.add_visited_guest()
    visited = case.client(org.author, other.id)
    assert _ok(visited.get(ROOT + "/direct-blocks"))["pagination"]["total"] == 0
    assert visited.delete(f"{ROOT}/direct-blocks/{org.peer}").status_code == 204
    assert _ok(admin.get(ROOT + "/direct-blocks"))["pagination"]["total"] == 2


def test_direct_collision_rechecks_current_policy_after_full_rollback(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    staged, competing, release = Event(), Event(), Event()
    first_pid = []

    def hold_first(db):
        context = db.info.get(AUDIT_CONTEXT_KEY)
        if db.get_bind() is not case.world.runtime or context is None or staged.is_set():
            return
        if context.request_path != ROOT + "/directs" or context.performed_by != org.author:
            return
        db.flush()
        first_pid.append(db.connection().connection.driver_connection.info.backend_pid)
        staged.set()
        assert release.wait(WAIT)

    def observe_second(connection, _cursor, _statement, _parameters, context, _many):
        statement = context.compiled.statement if context.compiled is not None else None
        if (
            first_pid
            and getattr(getattr(statement, "table", None), "name", None) == "comms_conversations"
        ):
            if (
                getattr(statement, "is_insert", False)
                and connection.connection.driver_connection.info.backend_pid != first_pid[0]
            ):
                competing.set()

    event.listen(AuditSession, "before_commit", hold_first)
    event.listen(case.world.runtime, "before_cursor_execute", observe_second)
    try:
        with ThreadPoolExecutor(max_workers=2) as workers:
            first = workers.submit(
                admin.post, ROOT + "/directs", json={"recipient_id": str(org.peer)}
            )
            try:
                assert staged.wait(WAIT)
                second = workers.submit(
                    peer.post, ROOT + "/directs", json={"recipient_id": str(org.author)}
                )
                assert competing.wait(WAIT)
                with case.world.session(org) as db:
                    db.add(
                        CommsDirectBlock(
                            org_id=org.id, user_id=org.author, blocked_user_id=org.peer
                        )
                    )
                    db.commit()
            finally:
                release.set()
            assert first.result(timeout=WAIT).status_code == 201
            refused = second.result(timeout=WAIT)
            _error(refused, 403, "comms_post_denied")
            assert "blocked" not in refused.text.lower()
    finally:
        release.set()
        event.remove(AuditSession, "before_commit", hold_first)
        event.remove(case.world.runtime, "before_cursor_execute", observe_second)
