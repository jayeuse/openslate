"""Non-enumerating requests and manager-controlled membership admission."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Barrier
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select
from uuid6 import uuid7

from app.systems.access.policy.models import GroupMember
from app.systems.comms.conversations.models import CommsMember
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.comms.routes.message_support import _ok
from tests.conftest import create_member

pytestmark = pytest.mark.integration


def test_private_join_request_is_neutral_deduplicated_and_manager_decided(
    tools_routes, monkeypatch
):
    case, org = tools_routes, tools_routes.world.first
    outsider = case.world.second.author
    case.add_home_members(outsider)
    admin, actor = case.client(org.author, org.id), case.client(outsider, org.id)
    room = _ok(
        admin.post(
            "/api/comms/conversations",
            json={
                "name": "Request channel",
                "scope": "members",
                "member_ids": [],
                "category_id": None,
                "topic": "",
                "position": 0,
            },
        ),
        201,
    )
    root = "/api/comms/conversations/" + room["id"]
    settings_path = "/api/comms/settings/channel/" + room["id"]
    current = admin.get(settings_path)
    assert (
        admin.patch(
            settings_path,
            json={"join_rule": "request"},
            headers={"If-Match": current.headers["etag"]},
        ).status_code
        == 200
    )
    assert actor.get(root).status_code == 404
    publications = []
    monkeypatch.setattr(actor.app.state.comms_publisher, "submit", publications.extend)
    for identity in (str(uuid4()), str(case.world.second.conversation), room["id"], room["id"]):
        response = actor.post("/api/comms/join-requests", json={"conversation_id": identity})
        assert response.status_code == 204 and response.content == b""
    assert publications and {row["topic"] for row in publications} == {
        f"org:{org.id}:user:{org.author}"
    }
    assert len(publications) == 1  # Unknown/repeated submissions produce no existence side channel.
    assert actor.get(root + "/admissions").status_code == 404
    page = _ok(admin.get(root + "/admissions"))
    assert page["pagination"]["total"] == 1
    admission = page["items"][0]
    assert admission["user_id"] == str(outsider) and admission["status"] == "pending"
    item = root + "/admissions/" + admission["id"]
    current = admin.get(item)
    assert admin.post(item + "/decision", json={"decision": "accept"}).status_code == 428
    accepted = _ok(
        admin.post(
            item + "/decision",
            json={"decision": "accept"},
            headers={"If-Match": current.headers["etag"]},
        )
    )
    assert accepted["status"] == "accepted" and accepted["resolved_at"] is not None
    assert actor.get(root).status_code == 200
    members = _ok(admin.get(root + "/members"))["items"]
    assert (
        next(row for row in members if row["user_id"] == str(outsider))["member_role"] == "member"
    )
    assert (
        admin.post(
            item + "/decision",
            json={"decision": "decline"},
            headers={"If-Match": current.headers["etag"]},
        ).status_code
        == 412
    )


def test_invitations_restore_only_member_role_and_reject_duplicate_pending_targets(tools_routes):
    case, org = tools_routes, tools_routes.world.first
    outsider = case.world.second.author
    case.add_home_members(outsider)
    api, peer = case.client(org.author, org.id), case.client(outsider, org.id)
    room = _ok(
        api.post(
            "/api/comms/conversations",
            json={
                "name": "Invitations",
                "scope": "members",
                "member_ids": [],
                "category_id": None,
                "topic": "",
                "position": 0,
            },
        ),
        201,
    )
    root = "/api/comms/conversations/" + room["id"]
    assert (
        api.post(root + "/invitations", json={"user_id": str(case.world.second.peer)}).status_code
        == 404
    )
    invitation = api.post(root + "/invitations", json={"user_id": str(outsider)})
    row = _ok(invitation, 201)
    assert row["kind"] == "invitation" and invitation.headers["location"].endswith(row["id"])
    assert api.post(root + "/invitations", json={"user_id": str(outsider)}).status_code == 409
    item = root + "/admissions/" + row["id"]
    assert (
        peer.post(
            item + "/decision",
            json={"decision": "accept"},
            headers={"If-Match": invitation.headers["etag"]},
        ).status_code
        == 404
    )
    assert (
        api.post(
            item + "/decision",
            json={"decision": "accept"},
            headers={"If-Match": invitation.headers["etag"]},
        ).status_code
        == 200
    )
    member_path = root + "/members/" + str(outsider)
    current = api.get(root)
    assert (
        api.put(
            member_path, json={"role": "manager"}, headers={"If-Match": current.headers["etag"]}
        ).status_code
        == 200
    )
    current = api.get(root)
    assert api.delete(member_path, headers={"If-Match": current.headers["etag"]}).status_code == 204
    assert peer.get(root).status_code == 404
    invitation = api.post(root + "/invitations", json={"user_id": str(outsider)})
    restored = _ok(invitation, 201)
    assert (
        api.post(
            root + "/admissions/" + restored["id"] + "/decision",
            json={"decision": "accept"},
            headers={"If-Match": invitation.headers["etag"]},
        ).status_code
        == 200
    )
    with case.world.session(org) as db:
        members = list(
            db.scalars(
                select(CommsMember).where(
                    CommsMember.conversation_id == UUID(room["id"]),
                    CommsMember.user_id == outsider,
                )
            )
        )
        assert len(members) == 1 and members[0].role == "member" and not members[0].is_deleted


def test_concurrent_admission_decisions_create_one_membership_or_none_atomically(tools_routes):
    case, org = tools_routes, tools_routes.world.first
    outsider = case.world.second.author
    case.add_home_members(outsider)
    api = case.client(org.author, org.id)
    invitation = api.post(
        f"/api/comms/conversations/{org.conversation}/invitations", json={"user_id": str(outsider)}
    )
    row = _ok(invitation, 201)
    path = f"/api/comms/conversations/{org.conversation}/admissions/{row['id']}"
    gate = Barrier(2)
    clients = [case.client(org.author, org.id, request_gate=gate) for _ in range(2)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(
                client.post,
                path + "/decision",
                json={"decision": value},
                headers={"If-Match": invitation.headers["etag"]},
            )
            for client, value in zip(clients, ("accept", "decline"), strict=True)
        ]
        results = [future.result(timeout=30) for future in futures]
    assert sorted(response.status_code for response in results) == [200, 412]
    terminal = _ok(api.get(path))
    assert terminal["status"] in ("accepted", "declined") and terminal["resolved_at"] is not None
    with case.world.session(org) as db:
        assert db.scalar(
            select(func.count())
            .select_from(CommsMember)
            .where(
                CommsMember.conversation_id == org.conversation,
                CommsMember.user_id == outsider,
                CommsMember.is_deleted.is_(False),
            )
        ) == (1 if terminal["status"] == "accepted" else 0)
        assert (
            db.scalar(
                select(func.count())
                .select_from(AuditLog)
                .where(
                    AuditLog.entity_type == "comms_admissions",
                    AuditLog.entity_id == UUID(row["id"]),
                    AuditLog.action == "update",
                )
            )
            == 1
        )


def test_request_audience_tracks_delegated_management_without_notifying_requesters(
    tools_routes, monkeypatch
):
    case, org = tools_routes, tools_routes.world.first
    left, right = case.world.second.author, case.world.second.peer
    case.add_home_members(left, right)
    api = case.client(org.author, org.id)
    room = _ok(
        api.post(
            "/api/comms/conversations",
            json={
                "name": "Managed request channel",
                "scope": "members",
                "member_ids": [str(org.peer)],
                "category_id": None,
                "topic": "",
                "position": 0,
            },
        ),
        201,
    )
    root = "/api/comms/settings/channel/" + room["id"]
    current = api.get(root)
    configured = api.patch(
        root, json={"join_rule": "request"}, headers={"If-Match": current.headers["etag"]}
    )
    assert configured.status_code == 200
    with case.world.session(org) as db:
        membership = GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer)
        db.add(membership)
        db.commit()
        membership_id = membership.id
    assert (
        api.put(
            root + "/capabilities",
            json={
                "scope": {"kind": "channel", "id": room["id"]},
                "everyone": {},
                "group_grants": [{"group_id": str(org.group), "capability": "manageChannel"}],
            },
            headers={"If-Match": configured.headers["etag"]},
        ).status_code
        == 200
    )
    for actor, expected in ((left, {org.author, org.peer}), (right, {org.author})):
        client = case.client(actor, org.id)
        publications = []
        monkeypatch.setattr(client.app.state.comms_publisher, "submit", publications.extend)
        assert (
            client.post(
                "/api/comms/join-requests", json={"conversation_id": room["id"]}
            ).status_code
            == 204
        )
        assert {row["topic"] for row in publications} == {
            f"org:{org.id}:user:{identity}" for identity in expected
        }
        with case.world.session(org) as db:
            db.get(GroupMember, membership_id).is_deleted = True
            db.commit()


def test_guest_request_acceptance_grants_read_membership_not_writing(tools_routes):
    case, org = tools_routes, tools_routes.world.first
    with case.world.session(org) as db:
        guest, _ = create_member(
            db,
            db.get(WorkspaceProfile, org.id),
            "guest",
            sponsor_user_id=org.author,
            expires_at=datetime(2100, 1, 1, tzinfo=UTC),
            supabase_user_id=uuid7(),
        )
        guest_id = guest.id
        db.commit()
    case.world.additional_users.append(guest_id)
    api, guest_api = case.client(org.author, org.id), case.client(guest_id, org.id)
    room = _ok(
        api.post(
            "/api/comms/conversations",
            json={
                "name": "Guest requests",
                "scope": "members",
                "member_ids": [],
                "category_id": None,
                "topic": "",
                "position": 0,
            },
        ),
        201,
    )
    root = "/api/comms/conversations/" + room["id"]
    settings = "/api/comms/settings/channel/" + room["id"]
    current = api.get(settings)
    assert (
        api.patch(
            settings, json={"join_rule": "request"}, headers={"If-Match": current.headers["etag"]}
        ).status_code
        == 200
    )
    assert (
        guest_api.post("/api/comms/join-requests", json={"conversation_id": room["id"]}).status_code
        == 204
    )
    admission = _ok(api.get(root + "/admissions"))["items"][0]
    current = api.get(root + "/admissions/" + admission["id"])
    assert (
        api.post(
            root + "/admissions/" + admission["id"] + "/decision",
            json={"decision": "accept"},
            headers={"If-Match": current.headers["etag"]},
        ).status_code
        == 200
    )
    assert _ok(guest_api.get(root))["level"] == "read"
    assert (
        guest_api.post(
            root + "/messages", json={"client_key": str(uuid4()), "body": "Not permitted"}
        ).status_code
        == 403
    )
