"""D45 access grant routes: managers add read or post on channels and categories."""

from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy import select, text
from uuid6 import uuid7

from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.comms.conversations.models import CommsConversation, CommsMember
from app.systems.comms.realtime.models import CommsRealtimeGrant
from app.systems.comms.settings.models import CommsCapabilityGrant
from tests.comms.conftest import NOW
from tests.comms.routes.message_support import send
from tests.comms.routes.structure_support import ROOT, _error, _ok, _read, _snapshot, _tag
from tests.comms.routes.test_comms_notification_routes import inbox_client, notices

pytestmark = pytest.mark.integration
FUTURE = datetime(2100, 1, 1, tzinfo=UTC)


def _department_channel(case):
    """org.other_conversation becomes Finance: a department channel in org.category."""
    org = case.world.first
    with case.world.session(org) as db:
        channel = db.get(CommsConversation, org.other_conversation)
        channel.scope, channel.department_id = "department", org.department
        for row in db.scalars(
            select(CommsMember).where(
                CommsMember.org_id == org.id,
                CommsMember.user_id == org.peer,
            )
        ):
            row.is_deleted, row.deleted_at = True, NOW
        db.commit()
    return f"{ROOT}/conversations/{org.other_conversation}"


def _level(api, path):
    response = api.get(path)
    return response.json()["level"] if response.status_code == 200 else response.status_code


def test_channel_grant_gives_read_and_post_mentions_notifications_and_is_revoked_at_once(
    structure_routes,
):
    case, org, other = structure_routes, structure_routes.world.first, structure_routes.world.second
    case.add_home_members(other.peer)  # An organization member with no department role.
    path = _department_channel(case)
    admin = inbox_client(case, org.author, org.id)
    outsider = inbox_client(case, other.peer, org.id)
    grants, target = f"{path}/access-grants", f"{path}/access-grants/user/{other.peer}"
    assert _level(outsider, path) == 404
    empty = _read(admin, grants)
    assert empty.json() == {"items": []}
    _error(admin.put(target, json={"level": "post"}), 428, "comms_precondition_required")
    created = admin.put(target, headers={"If-Match": _tag(empty)}, json={"level": "post"})
    body = _ok(created, 201)
    assert (
        created.headers["location"] == f"/api/comms/conversations/{org.other_conversation}"
        f"/access-grants/user/{other.peer}"
    )
    assert (body["subject"], body["subject_id"], body["level"], body["source"]) == (
        "user",
        str(other.peer),
        "post",
        "channel",
    )
    assert set(body) == {
        "subject",
        "subject_id",
        "display_name",
        "departments",
        "level",
        "source",
        "created_at",
        "updated_at",
    }
    assert body["departments"] == []  # A person row names their departments; this one has none.
    assert _tag(created) == _tag(_read(admin, path)) != _tag(empty)
    _error(
        admin.put(target, headers={"If-Match": _tag(empty)}, json={"level": "read"}),
        412,
        "comms_precondition_failed",
    )
    # G1: the outsider reads and posts; G5: mentionable, notified and listed.
    assert _level(outsider, path) == "post"
    send(outsider, f"{path}/messages", "From inventory")
    named = send(admin, f"{path}/messages", "Named", mention_user_ids=[str(other.peer)])
    everyone = send(admin, f"{path}/messages", "Everyone", mentions_channel=True)
    assert sorted((row["kind"], row["message_id"]) for row in notices(outsider)) == sorted(
        [
            ("comms-mention", named["id"]),
            ("comms-mention", everyone["id"]),
        ]
    )
    members = _ok(admin.get(f"{path}/members", params={"limit": 100}))["items"]
    assert {row["user_id"]: (row["member_role"], row["level"]) for row in members}[
        str(other.peer)
    ] == ("member", "post")
    changed = admin.put(
        target, headers={"If-Match": _tag(_read(admin, path))}, json={"level": "read"}
    )
    assert (_ok(changed)["level"], _level(outsider, path)) == ("read", "read")
    refused = outsider.post(f"{path}/messages", json={"client_key": str(uuid7()), "body": "x"})
    assert refused.status_code == 403, refused.text
    with case.world.session(org) as db:
        db.add(
            CommsRealtimeGrant(
                org_id=org.id,
                user_id=other.peer,
                conversation_id=org.other_conversation,
                expires_at=FUTURE,
            )
        )
        db.commit()
    try:
        _error(admin.delete(target), 428, "comms_precondition_required")
        removed = admin.delete(target, headers={"If-Match": _tag(_read(admin, path))})
        assert removed.status_code == 204 and removed.content == b""
        # G4: content is refused at once and the Realtime topic grant is gone.
        assert _level(outsider, path) == 404
        with case.world.session(org) as db:
            assert (
                db.scalars(
                    select(CommsRealtimeGrant).where(
                        CommsRealtimeGrant.user_id == other.peer,
                    )
                ).all()
                == []
            )
    finally:
        with case.world.owner.begin() as connection:
            connection.execute(
                text("DELETE FROM public.comms_realtime_grants WHERE org_id = :org"),
                {"org": org.id},
            )
    _error(
        admin.delete(target, headers={"If-Match": _tag(_read(admin, path))}),
        404,
        "comms_not_found",
    )


def test_grant_routes_refuse_non_managers_private_conversations_and_foreign_subjects(
    structure_routes,
):
    case, org, other = structure_routes, structure_routes.world.first, structure_routes.world.second
    case.add_home_members(other.author)  # other.peer stays outside this organization.
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    channel = f"{ROOT}/conversations/{org.conversation}"
    category = f"{ROOT}/categories/{org.category}"
    before = _snapshot(case)
    # G6: a reader without manageChannel cannot list, search or change grants.
    tag = _tag(_read(peer, channel))
    for target in (channel, category):
        _error(peer.get(f"{target}/access-grants"), 403, "comms_capability_denied")
        _error(
            peer.get(f"{target}/access-candidates", params={"q": "person"}),
            403,
            "comms_capability_denied",
        )
        _error(
            peer.put(
                f"{target}/access-grants/user/{other.author}",
                headers={"If-Match": tag},
                json={"level": "read"},
            ),
            403,
            "comms_capability_denied",
        )
        _error(
            peer.delete(f"{target}/access-grants/user/{other.author}", headers={"If-Match": tag}),
            403,
            "comms_capability_denied",
        )
    assert _snapshot(case) == before
    group = _ok(
        admin.post(
            f"{ROOT}/groups",
            json={
                "name": "Hand-picked",
                "participant_ids": [str(org.author), str(org.peer), str(other.author)],
            },
        ),
        201,
    )
    group_path = f"{ROOT}/conversations/{group['id']}"
    _error(admin.get(f"{group_path}/access-grants"), 422, "comms_invalid")
    _error(
        admin.put(
            f"{group_path}/access-grants/user/{org.peer}",
            headers={"If-Match": _tag(_read(admin, group_path))},
            json={"level": "read"},
        ),
        422,
        "comms_invalid",
    )
    # An organization channel already lets every member post: grants are refused there.
    tag = _tag(_read(admin, channel))
    _error(
        admin.put(
            f"{channel}/access-grants/user/{other.author}",
            headers={"If-Match": tag},
            json={"level": "read"},
        ),
        422,
        "comms_invalid",
    )
    _error(
        admin.delete(f"{channel}/access-grants/user/{other.author}", headers={"If-Match": tag}),
        422,
        "comms_invalid",
    )
    channel = _department_channel(case)
    before = _snapshot(case)
    tag = _tag(_read(admin, channel))
    for subject, identity in (
        ("user", other.peer),  # An account of another organization only.
        ("group", other.group),  # A group of another organization.
        ("user", uuid7()),
        ("group", uuid7()),
    ):
        _error(
            admin.put(
                f"{channel}/access-grants/{subject}/{identity}",
                headers={"If-Match": tag},
                json={"level": "post"},
            ),
            404,
            "comms_not_found",
        )
    for bad in ({"level": "manage"}, {"level": "read", "extra": 1}, {}):
        response = admin.put(
            f"{channel}/access-grants/user/{other.author}",
            headers={"If-Match": tag},
            json=bad,
        )
        assert response.status_code == 422, response.text
    response = admin.put(
        f"{channel}/access-grants/everyone/{other.author}",
        headers={"If-Match": tag},
        json={"level": "read"},
    )
    assert response.status_code == 422, response.text
    assert _snapshot(case) == before


def test_category_grant_reaches_its_channels_adds_to_channel_grants_and_stops_on_move(
    structure_routes,
):
    # G8 on a department-bound category, for a person outside that department.
    case, org, other = structure_routes, structure_routes.world.first, structure_routes.world.second
    case.add_home_members(other.peer)
    path = _department_channel(case)  # In org.category, which belongs to org.department.
    category = f"{ROOT}/categories/{org.category}"
    admin, outsider = case.client(org.author, org.id), case.client(other.peer, org.id)
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=other.peer))
        db.commit()
    channel_tag = _tag(_read(admin, path))
    created = admin.put(
        f"{category}/access-grants/group/{org.group}",
        headers={"If-Match": _tag(_read(admin, category))},
        json={"level": "read"},
    )
    assert (_ok(created, 201)["source"], created.headers["location"]) == (
        "category",
        f"/api/comms/categories/{org.category}/access-grants/group/{org.group}",
    )
    assert _tag(created) == _tag(_read(admin, category))
    assert _level(outsider, path) == "read"
    # Inherited, not copied: the channel's own token and grants are unchanged.
    assert _tag(_read(admin, path)) == channel_tag
    listed = _ok(admin.get(f"{path}/access-grants"))["items"]
    assert [(row["subject"], row["subject_id"], row["level"], row["source"]) for row in listed] == [
        ("group", str(org.group), "read", "category")
    ]
    _ok(
        admin.put(
            f"{path}/access-grants/user/{other.peer}",
            headers={"If-Match": channel_tag},
            json={"level": "post"},
        ),
        201,
    )
    assert _level(outsider, path) == "post"
    listed = _ok(admin.get(f"{path}/access-grants"))["items"]
    assert [row["source"] for row in listed] == ["channel", "category"]
    assert [row["departments"] for row in listed] == [[], None]  # A group row has none.
    # An inherited grant is removed on its category, never through the channel.
    _error(
        admin.delete(
            f"{path}/access-grants/group/{org.group}",
            headers={"If-Match": _tag(_read(admin, path))},
        ),
        404,
        "comms_not_found",
    )
    removed = admin.delete(
        f"{path}/access-grants/user/{other.peer}", headers={"If-Match": _tag(_read(admin, path))}
    )
    assert removed.status_code == 204
    assert _level(outsider, path) == "read"
    moved = admin.patch(
        path, headers={"If-Match": _tag(_read(admin, path))}, json={"category_id": None}
    )
    assert _ok(moved)["category_id"] is None
    assert _level(outsider, path) == 404


def test_candidate_search_finds_only_this_organizations_people_and_groups_without_contacts(
    structure_routes,
):
    # G7: names and departments only; people and groups of another organization never.
    case, org, other = structure_routes, structure_routes.world.first, structure_routes.world.second
    case.add_home_members(other.author)
    path = _department_channel(case)
    admin = case.client(org.author, org.id)
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            GroupAccess(
                org_id=org.id,
                group_id=org.group,
                department_id=org.department,
                level="read",
            )
        )
        db.commit()
    for target in (path, f"{ROOT}/categories/{org.category}"):
        response = admin.get(f"{target}/access-candidates", params={"q": "person-"})
        found = _ok(response)
        assert "no-store" in response.headers["cache-control"]
        people = {row["user_id"]: row for row in found["people"]}
        assert set(people) == {str(org.author), str(org.peer), str(other.author)}
        assert all(
            set(row) == {"user_id", "display_name", "departments"} for row in people.values()
        )
        assert people[str(org.peer)]["departments"] == [
            {"id": str(org.department), "name": "Comms fixture"},
        ]
        assert people[str(other.author)]["departments"] == []
        assert found["groups"] == []
    granted = admin.put(
        f"{path}/access-grants/user/{org.peer}",
        headers={"If-Match": _tag(_read(admin, path))},
        json={"level": "read"},
    )
    assert _ok(granted, 201)["departments"] == [
        {"id": str(org.department), "name": "Comms fixture"},
    ]
    groups = _ok(admin.get(f"{path}/access-candidates", params={"q": "fixture group"}))
    # Both organizations own a group with this name; only this organization's is found.
    assert groups["people"] == []
    assert groups["groups"] == [{"id": str(org.group), "name": "Comms fixture group"}]
    only_people = _ok(
        admin.get(
            f"{path}/access-candidates",
            params={"q": "o", "kind": "user", "limit": 1},
        )
    )
    assert (len(only_people["people"]), only_people["groups"]) == (1, [])
    for params in ({"q": ""}, {"q": "x", "limit": 21}, {"q": "x", "kind": "everyone"}):
        assert admin.get(f"{path}/access-candidates", params=params).status_code == 422
    assert UUID(only_people["people"][0]["user_id"])


def test_category_grant_authors_are_admins_and_department_managers_only(structure_routes):
    # A category manageChannel capability alone could grant its holder every channel there.
    case, org, other = structure_routes, structure_routes.world.first, structure_routes.world.second
    case.add_home_members(other.author)
    category = f"{ROOT}/categories/{org.category}"
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            CommsCapabilityGrant(
                org_id=org.id,
                scope="category",
                category_id=org.category,
                subject="group",
                group_id=org.group,
                capability="manageChannel",
                granted=True,
            )
        )
        managers = Group(org_id=org.id, name="Department managers")
        db.add(managers)
        db.flush()
        db.add(GroupMember(org_id=org.id, group_id=managers.id, user_id=other.author))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=managers.id, department_id=org.department, level="manage"
            )
        )
        db.commit()
    admin, holder = case.client(org.author, org.id), case.client(org.peer, org.id)
    manager = case.client(other.author, org.id)
    assert _ok(holder.get(f"{category}/access-grants")) == {"items": []}
    before = _snapshot(case)
    for request in (holder.put, holder.delete):
        kwargs = {"json": {"level": "read"}} if request == holder.put else {}
        _error(
            request(
                f"{category}/access-grants/user/{org.peer}",
                headers={"If-Match": _tag(_read(holder, category))},
                **kwargs,
            ),
            403,
            "comms_capability_denied",
        )
    assert _snapshot(case) == before
    _ok(
        admin.put(
            f"{category}/access-grants/group/{org.group}",
            headers={"If-Match": _tag(_read(admin, category))},
            json={"level": "read"},
        ),
        201,
    )
    _ok(
        manager.put(
            f"{category}/access-grants/user/{org.peer}",
            headers={"If-Match": _tag(_read(manager, category))},
            json={"level": "post"},
        ),
        201,
    )
    removed = manager.delete(
        f"{category}/access-grants/group/{org.group}",
        headers={"If-Match": _tag(_read(manager, category))},
    )
    assert removed.status_code == 204
    listed = _ok(admin.get(f"{category}/access-grants"))["items"]
    assert [(row["subject"], row["subject_id"], row["level"]) for row in listed] == [
        ("user", str(org.peer), "post"),
    ]


def test_a_manager_cannot_remove_the_grant_that_gives_them_read(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    path = _department_channel(case)  # org.peer has no department role here.
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            CommsCapabilityGrant(
                org_id=org.id,
                scope="channel",
                conversation_id=org.other_conversation,
                subject="group",
                group_id=org.group,
                capability="manageChannel",
                granted=True,
            )
        )
        db.commit()
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    target = f"{path}/access-grants/user/{org.peer}"
    _ok(
        admin.put(target, headers={"If-Match": _tag(_read(admin, path))}, json={"level": "read"}),
        201,
    )
    assert _level(peer, path) == "read"
    before = _snapshot(case)
    _error(
        peer.delete(target, headers={"If-Match": _tag(_read(peer, path))}),
        409,
        "comms_conflict",
    )
    assert _snapshot(case) == before
    assert _level(peer, path) == "read"
