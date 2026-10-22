"""Conversation membership, group cardinality and privacy stay independent of account roles."""

from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.access.users.models import Membership, User
from app.systems.comms.conversations.models import CommsConversation, CommsMember
from app.systems.comms.settings.models import CommsCapabilityGrant
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.comms.routes.structure_support import (
    ROOT,
    _channel,
    _created,
    _error,
    _ok,
    _read,
    _rights,
    _snapshot,
    _tag,
)
from tests.conftest import create_member
from tests.organization_scope_support import organization_bindings

pytestmark = pytest.mark.integration


@pytest.fixture
def named_members(structure_routes):
    case, org, other = structure_routes, structure_routes.world.first, structure_routes.world.second
    actors = (org.author, org.peer, other.author, other.peer)
    request_id = None
    try:
        with case.world.session(org) as db:
            request_id = db.info[AUDIT_CONTEXT_KEY].request_id
            for actor, name in zip(actors, ("Alpha", "Bravo", "Charlie", "Delta"), strict=True):
                db.get(User, actor).display_name = name
            db.commit()
        yield
    finally:
        if request_id is not None:
            with Session(case.world.owner) as db:
                for row in db.scalars(
                    select(AuditLog).where(
                        AuditLog.org_id.is_(None),
                        AuditLog.entity_type == "users",
                        AuditLog.entity_id.in_(actors),
                        AuditLog.request_id == request_id,
                    )
                ):
                    db.delete(row)
                db.commit()


def test_membership_grant_role_removal_and_group_floor_are_distinct_atomic_commands(
    structure_routes,
    named_members,
):
    case, org, other = structure_routes, structure_routes.world.first, structure_routes.world.second
    case.add_home_members(other.author, other.peer)
    admin, delegate, removed = (
        case.client(actor, org.id) for actor in (org.author, org.peer, other.author)
    )
    # D44: every organization member reads this channel; a member row only marks a manager.
    channel, path = _created(admin, f"{ROOT}/conversations", _channel("Managed membership"))
    target = f"{path}/members/{other.author}"
    before = _snapshot(case)
    _error(
        delegate.put(
            target, headers={"If-Match": _tag(_read(delegate, path))}, json={"role": "manager"}
        ),
        403,
        "comms_capability_denied",
    )
    assert _snapshot(case) == before
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            CommsCapabilityGrant(
                org_id=org.id,
                scope="channel",
                conversation_id=UUID(channel["id"]),
                subject="group",
                group_id=org.group,
                capability="manageChannel",
                granted=True,
            )
        )
        db.commit()
    rights = _rights(case, org.peer, channel["id"])
    assert rights["manager_source"] is None
    assert rights["capabilities"]["manageChannel"]["allowed"] is True
    assert rights["capabilities"]["moderate"]["allowed"] is False
    assert rights["capabilities"]["manageWorkspace"]["allowed"] is False
    old = _read(delegate, path)
    _error(delegate.put(target, json={"role": "manager"}), 428, "comms_precondition_required")
    assigned = _ok(delegate.put(target, headers={"If-Match": _tag(old)}, json={"role": "manager"}))
    assert (assigned["user_id"], assigned["member_role"], assigned["level"]) == (
        str(other.author),
        "manager",
        "manage",
    )
    current = _read(delegate, path)
    assert _tag(current) != _tag(old)
    before = _snapshot(case)
    _error(
        delegate.put(target, headers={"If-Match": _tag(old)}, json={"role": "member"}),
        412,
        "comms_precondition_failed",
    )
    _error(delegate.delete(target), 428, "comms_precondition_required")
    _error(
        delegate.delete(target, headers={"If-Match": _tag(old)}), 412, "comms_precondition_failed"
    )
    assert _snapshot(case) == before
    assert _rights(case, other.author, channel["id"])["manager_source"] == "membership_manager"
    deleted = delegate.delete(target, headers={"If-Match": _tag(current)})
    assert deleted.status_code == 204 and deleted.content == b""
    # Removing the manager row leaves the organization reader in place as a member.
    assert _ok(removed.get(path))["level"] == "post"
    assert _rights(case, other.author, channel["id"])["manager_source"] is None
    assert {
        r["user_id"]: (r["member_role"], r["level"])
        for r in _ok(delegate.get(path + "/members"))["items"]
    }[str(other.author)] == ("member", "post")
    _error(
        delegate.delete(target, headers={"If-Match": _tag(_read(delegate, path))}),
        404,
        "comms_not_found",
    )
    promoted = delegate.put(
        target, headers={"If-Match": _tag(_read(delegate, path))}, json={"role": "manager"}
    )
    assert _ok(promoted)["member_role"] == "manager"
    demoted = _ok(
        delegate.put(
            target, headers={"If-Match": _tag(_read(delegate, path))}, json={"role": "member"}
        )
    )
    assert (demoted["member_role"], demoted["level"]) == ("member", "post")
    assert _rights(case, other.author, channel["id"])["manager_source"] is None
    with case.world.session(org) as db:
        # Only a current reader can become a manager: a department channel nobody else reads.
        room = db.get(CommsConversation, UUID(channel["id"]))
        room.scope, room.department_id = "department", org.department
        db.commit()
    before = _snapshot(case)
    _error(
        admin.put(
            f"{path}/members/{other.peer}",
            headers={"If-Match": _tag(_read(admin, path))},
            json={"role": "manager"},
        ),
        404,
        "comms_not_found",
    )
    assert _snapshot(case) == before
    with case.world.session(org) as db:
        assert (
            db.scalar(
                select(Membership.role).where(
                    Membership.org_id == org.id,
                    Membership.user_id == other.author,
                )
            )
            == "member"
        )
    participants = [str(actor) for actor in (org.author, org.peer, other.author, other.peer)]
    group, group_path = _created(
        admin,
        f"{ROOT}/groups",
        {
            "name": "Four to three",
            "participant_ids": participants,
        },
    )
    assert set(group["participant_ids"]) == set(participants)
    query = {"sort_by": "display_name", "sort_order": "asc", "limit": 2}
    first = _ok(admin.get(group_path + "/members", params=query))
    last = _ok(admin.get(group_path + "/members", params=query | {"offset": 2}))
    assert [r["user_id"] for r in first["items"]] == participants[:2]
    assert [r["display_name"] for r in first["items"]] == ["Alpha", "Bravo"]
    assert [r["user_id"] for r in last["items"]] == participants[2:]
    assert first["pagination"] == {
        "limit": 2,
        "offset": 0,
        "count": 2,
        "total": 4,
        "has_more": True,
    }
    assert last["pagination"] == {
        "limit": 2,
        "offset": 2,
        "count": 2,
        "total": 4,
        "has_more": False,
    }
    _error(admin.get(f"{ROOT}/conversations/{other.conversation}/members"), 404, "comms_not_found")
    response = admin.delete(
        f"{group_path}/members/{other.peer}", headers={"If-Match": _tag(_read(admin, group_path))}
    )
    assert response.status_code == 204 and response.content == b""
    current = _read(admin, group_path)
    assert set(current.json()["participant_ids"]) == set(participants[:3])
    tail = _ok(admin.get(group_path + "/members", params=query | {"offset": 2}))
    assert [r["user_id"] for r in tail["items"]] == [str(other.author)]
    assert tail["pagination"]["total"] == 3
    before = _snapshot(case)
    _error(
        admin.delete(f"{group_path}/members/{other.author}", headers={"If-Match": _tag(current)}),
        409,
        "comms_conflict",
    )
    assert _snapshot(case) == before
    for people in (participants[:2], participants[:2] + [participants[1]], participants[1:]):
        _error(
            admin.post(f"{ROOT}/groups", json={"name": "Invalid", "participant_ids": people}), 422
        )
        assert _snapshot(case) == before


def test_channel_members_are_its_readers_with_level_role_paging_and_search(
    structure_routes, named_members,
):
    case, org, other = structure_routes, structure_routes.world.first, structure_routes.world.second
    case.add_home_members(other.author, other.peer)  # Charlie and Delta: members with no rows.
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    query = {"sort_by": "display_name", "sort_order": "asc", "limit": 100}

    def listed(api, conversation):
        path = f"{ROOT}/conversations/{conversation}"
        page = _ok(api.get(path + "/members", params=query))
        assert page["pagination"]["total"] == len(page["items"])
        assert _ok(api.get(path))["member_count"] == page["pagination"]["total"]
        return [(row["display_name"], row["member_role"], row["level"]) for row in page["items"]]

    # D44 A6: "manager" exactly when the reader's level is manage; the admin manages.
    assert listed(peer, org.conversation) == [
        ("Alpha", "manager", "manage"),
        ("Bravo", "member", "post"),
        ("Charlie", "member", "post"),
        ("Delta", "member", "post"),
    ]
    path = f"{ROOT}/conversations/{org.conversation}"
    assert (_ok(admin.get(path))["member_role"], _ok(peer.get(path))["member_role"]) == (
        "manager",
        "member",
    )
    first = _ok(peer.get(path + "/members", params=query | {"limit": 2}))
    rest = _ok(peer.get(path + "/members", params=query | {"limit": 2, "offset": 2}))
    assert [row["display_name"] for row in first["items"] + rest["items"]] == [
        "Alpha", "Bravo", "Charlie", "Delta",
    ]
    assert first["pagination"] == {
        "limit": 2, "offset": 0, "count": 2, "total": 4, "has_more": True,
    }
    assert rest["pagination"] == {
        "limit": 2, "offset": 2, "count": 2, "total": 4, "has_more": False,
    }
    found = _ok(peer.get(path + "/members", params=query | {"search": "char"}))
    assert [row["display_name"] for row in found["items"]] == ["Charlie"]
    assert found["pagination"]["total"] == 1
    with case.world.session(org) as db:
        department = db.get(CommsConversation, org.other_conversation)
        department.scope, department.department_id = "department", org.department
        db.commit()
    # Bravo keeps a member row but has no department access, so Bravo is not a reader.
    assert listed(admin, org.other_conversation) == [("Alpha", "manager", "manage")]
    with case.world.session(org) as db:
        readers = Group(org_id=org.id, name="Department readers")
        db.add(readers)
        db.flush()
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=other.author))
        db.add(GroupMember(org_id=org.id, group_id=readers.id, user_id=other.peer))
        db.add(GroupAccess(
            org_id=org.id, group_id=org.group, department_id=org.department, level="write",
        ))
        reader_access = GroupAccess(
            org_id=org.id, group_id=readers.id, department_id=org.department, level="read",
        )
        db.add(reader_access)
        db.flush()
        reader_access_id = reader_access.id
        db.commit()
    assert listed(admin, org.other_conversation) == [
        ("Alpha", "manager", "manage"),
        ("Charlie", "member", "post"),
        ("Delta", "member", "read"),
    ]
    with case.world.session(org) as db:
        db.scalars(select(CommsMember).where(
            CommsMember.conversation_id == org.other_conversation,
            CommsMember.user_id == org.peer,
        )).one().role = "manager"
        db.get(GroupAccess, reader_access_id).level = "manage"
        db.commit()
    # A manager row and department manage both make a manager.
    assert listed(admin, org.other_conversation) == [
        ("Alpha", "manager", "manage"),
        ("Bravo", "manager", "manage"),
        ("Charlie", "member", "post"),
        ("Delta", "manager", "manage"),
    ]


def test_channel_creator_row_stays_through_role_changes(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    admin, creator = case.client(org.author, org.id), case.client(org.peer, org.id)
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=org.group, department_id=org.department, level="read"
            )
        )
        db.add(
            CommsCapabilityGrant(
                org_id=org.id,
                scope="workspace",
                subject="group",
                group_id=org.group,
                capability="createChannel",
                granted=True,
            )
        )
        db.commit()
    row, path = _created(
        creator,
        f"{ROOT}/conversations",
        _channel("Creator channel", None, "department", department_id=str(org.department)),
    )
    assert (row["level"], row["member_role"]) == ("manage", "manager")
    target = f"{path}/members/{org.peer}"

    def creator_row():
        with case.world.session(org) as db:
            return db.execute(select(CommsMember.role, CommsMember.is_deleted).where(
                CommsMember.conversation_id == UUID(row["id"]), CommsMember.user_id == org.peer,
            )).one()

    kept = _ok(admin.put(target, headers={"If-Match": _tag(_read(admin, path))}, json={
        "role": "member",
    }))
    assert (kept["member_role"], kept["level"]) == ("manager", "manage")
    assert tuple(creator_row()) == ("member", False)
    before = _snapshot(case)
    _error(
        admin.delete(target, headers={"If-Match": _tag(_read(admin, path))}),
        404,
        "comms_not_found",
    )
    assert _snapshot(case) == before
    _ok(admin.put(target, headers={"If-Match": _tag(_read(admin, path))}, json={
        "role": "manager",
    }))
    assert tuple(creator_row()) == ("manager", False)
    removed = admin.delete(target, headers={"If-Match": _tag(_read(admin, path))})
    assert removed.status_code == 204
    # The creator's row stays, so the creator still manages the channel.
    assert tuple(creator_row()) == ("member", False)
    assert _rights(case, org.peer, row["id"])["manager_source"] == "creator"
    assert _ok(creator.get(path))["level"] == "manage"


def test_group_admission_accepts_fifty_and_refuses_fifty_one(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    participants = [org.author, org.peer]
    with organization_bindings(), Session(case.world.owner) as db:
        organization = db.get(WorkspaceProfile, org.id)
        for _ in range(49):
            user, _ = create_member(db, organization, supabase_user_id=uuid7())
            participants.append(user.id)
            case.world.additional_users.append(user.id)
        db.commit()
    admin = case.client(org.author, org.id)
    row, _ = _created(
        admin,
        f"{ROOT}/groups",
        {
            "name": "Fifty",
            "participant_ids": [str(person) for person in participants[:50]],
        },
    )
    assert len(row["participant_ids"]) == 50 and set(row["participant_ids"]) == {
        str(person) for person in participants[:50]
    }
    before = _snapshot(case)
    _error(
        admin.post(
            f"{ROOT}/groups",
            json={
                "name": "Fifty one",
                "participant_ids": [str(person) for person in participants],
            },
        ),
        422,
    )
    assert _snapshot(case) == before
