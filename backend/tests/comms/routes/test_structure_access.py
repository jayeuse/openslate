"""ID27 response validity, exact department authority and filtered lifecycle pages."""

from uuid import UUID

import pytest
from sqlalchemy import select

from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.settings.models import CommsCapabilityGrant
from app.systems.sandbox.departments.models import Department
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
    _unchanged_read,
)

pytestmark = pytest.mark.integration


def test_id27_channel_responses_keep_department_read_and_commit_readable_downgrade(
    structure_routes,
):
    case, org = structure_routes, structure_routes.world.first
    admin, actor = case.client(org.author, org.id), case.client(org.peer, org.id)
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=org.group, department_id=org.department, level="read"
            )
        )
        db.commit()
    row, path = _created(
        admin,
        f"{ROOT}/conversations",
        _channel(
            "Sole department read",
            org.category,
            "department",
            department_id=str(org.department),
        ),
    )
    original = _read(actor, path)
    assert original.json()["level"] == "read"
    _error(
        actor.patch(path, headers={"If-Match": _tag(original)}, json={"topic": "No grant"}),
        403,
        "comms_capability_denied",
    )
    with case.world.session(org) as db:
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
        db.commit()
    assert _rights(case, org.peer, row["id"])["capabilities"]["manageChannel"]["allowed"] is True
    _ok(
        admin.patch(
            path, headers={"If-Match": _tag(_read(admin, path))}, json={"topic": "New revision"}
        )
    )
    current = _read(actor, path)
    before = _snapshot(case)
    _error(
        actor.patch(path, headers={"If-Match": _tag(original)}, json={"topic": "Stale"}),
        412,
        "comms_precondition_failed",
    )
    _error(actor.patch(path, json={"topic": "Unversioned"}), 428, "comms_precondition_required")
    assert _snapshot(case) == before
    _unchanged_read(actor, path, current)
    # Category capability authority may disappear, but category placement is never base read access.
    moved = actor.patch(
        path, headers={"If-Match": _tag(current)}, json={"category_id": None, "position": 7}
    )
    saved = _ok(moved)
    assert (saved["category_id"], saved["position"], saved["level"], saved["department_id"]) == (
        None,
        7,
        "read",
        str(org.department),
    )
    assert _tag(moved) != _tag(current)
    _unchanged_read(actor, path, moved)
    assert _rights(case, org.peer, row["id"])["capabilities"]["manageChannel"]["allowed"] is False
    before = _snapshot(case)
    _error(
        actor.patch(path, headers={"If-Match": _tag(moved)}, json={"topic": "No authority"}),
        403,
        "comms_capability_denied",
    )
    assert _snapshot(case) == before
    current = _read(admin, path)
    _error(
        admin.patch(
            path,
            headers={"If-Match": _tag(current)},
            json={
                "category_id": str(case.world.second.category),
                "position": 9,
                "topic": "Not saved",
            },
        ),
        404,
        "comms_not_found",
    )
    _unchanged_read(admin, path, current)


def test_department_management_does_not_reach_private_category_siblings(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    admin, manager = case.client(org.author, org.id), case.client(org.peer, org.id)
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=org.group, department_id=org.department, level="manage"
            )
        )
        db.commit()
    own, path = _created(
        admin,
        ROOT + "/conversations",
        _channel(
            "Own department",
            org.category,
            "department",
            department_id=str(org.department),
        ),
    )
    with case.world.session(org) as db:
        # D44: another department's channel stored in this category (setup bypasses A8).
        other = Department(org_id=org.id, department_name="Sibling department")
        db.add(other)
        db.flush()
        sibling = CommsConversation(
            org_id=org.id, kind="channel", scope="department", department_id=other.id,
            category_id=org.category, name="Other department sibling", created_by=org.author,
        )
        db.add(sibling)
        db.flush()
        hidden = {"id": str(sibling.id)}
        db.commit()
    hidden_path = ROOT + "/conversations/" + hidden["id"]
    assert _ok(manager.get(path))["level"] == "manage"
    _error(manager.get(hidden_path), 404, "comms_not_found")
    _error(
        manager.patch(
            hidden_path,
            headers={"If-Match": _tag(_read(admin, hidden_path))},
            json={"topic": "Not allowed"},
        ),
        404,
        "comms_not_found",
    )
    ids = {row["id"] for row in _ok(manager.get(ROOT + "/conversations"))["items"]}
    assert own["id"] in ids and hidden["id"] not in ids


def test_channel_lifecycle_filters_visible_rows_before_stable_pages_and_totals(structure_routes):
    case, org, foreign = (
        structure_routes,
        structure_routes.world.first,
        structure_routes.world.second,
    )
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    collection = ROOT + "/conversations"
    first, first_path = _created(admin, collection, _channel("Lifecycle twin"))
    second, _ = _created(admin, collection, _channel("Lifecycle twin"))
    with case.world.session(org) as db:
        # D44: the peer reads one department's channels; nobody but the admin reads the other.
        readers, other = Group(org_id=org.id, name="Lifecycle readers"), Department(
            org_id=org.id, department_name="Lifecycle hidden department"
        )
        db.add_all([readers, other])
        db.flush()
        db.add(GroupMember(org_id=org.id, group_id=readers.id, user_id=org.peer))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=readers.id, department_id=org.department, level="read"
            )
        )
        hidden_department = str(other.id)
        db.commit()
    restricted, restricted_path = _created(
        admin,
        collection,
        _channel(
            "Lifecycle private",
            scope="department",
            department_id=str(org.department),
            position=1,
        ),
    )
    hidden, hidden_path = _created(
        admin,
        collection,
        _channel(
            "Lifecycle hidden",
            scope="department",
            department_id=hidden_department,
            position=2,
        ),
    )
    twins = sorted((first["id"], second["id"]))
    query = {"search": "Lifecycle", "sort_by": "position", "sort_order": "asc", "limit": 2}
    page = _ok(peer.get(collection, params=query))
    assert [row["id"] for row in page["items"]] == twins
    assert page["pagination"] == {"limit": 2, "offset": 0, "count": 2, "total": 3, "has_more": True}
    tail = _ok(peer.get(collection, params=query | {"offset": 2}))
    assert [row["id"] for row in tail["items"]] == [restricted["id"]]
    assert tail["pagination"] == {
        "limit": 2,
        "offset": 2,
        "count": 1,
        "total": 3,
        "has_more": False,
    }
    old = _read(peer, first_path)
    _error(
        peer.post(first_path + "/archive", headers={"If-Match": _tag(old)}),
        403,
        "comms_capability_denied",
    )
    _error(
        admin.post(f"{collection}/{foreign.conversation}/restore", headers={"If-Match": _tag(old)}),
        404,
        "comms_not_found",
    )
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            CommsCapabilityGrant(
                org_id=org.id,
                scope="channel",
                conversation_id=UUID(first["id"]),
                subject="group",
                group_id=org.group,
                capability="manageChannel",
                granted=True,
            )
        )
        db.commit()
    _ok(
        peer.patch(
            first_path,
            headers={"If-Match": _tag(_read(peer, first_path))},
            json={"topic": "Changed"},
        )
    )
    current = _read(peer, first_path)
    before = _snapshot(case)
    _error(peer.post(first_path + "/archive"), 428, "comms_precondition_required")
    _error(
        peer.post(first_path + "/archive", headers={"If-Match": _tag(old)}),
        412,
        "comms_precondition_failed",
    )
    assert _snapshot(case) == before
    for target in (first_path, restricted_path, hidden_path):
        writer = peer if target == first_path else admin
        previous = _read(writer, target)
        archived = writer.post(target + "/archive", headers={"If-Match": _tag(previous)})
        assert _ok(archived)["archived_at"] is not None
        assert _tag(archived) != _tag(previous)
    assert [row["id"] for row in _ok(peer.get(collection, params=query))["items"]] == [second["id"]]
    archived = _ok(peer.get(collection, params=query | {"archived": "true"}))
    assert [row["id"] for row in archived["items"]] == [first["id"], restricted["id"]]
    assert archived["pagination"]["total"] == 2
    with case.world.session(org) as db:
        for grant in db.scalars(
            select(CommsCapabilityGrant).where(
                CommsCapabilityGrant.conversation_id == UUID(first["id"]),
            )
        ):
            db.delete(grant)
        db.commit()
    before = _snapshot(case)
    _error(
        peer.post(first_path + "/restore", headers={"If-Match": _tag(_read(peer, first_path))}),
        403,
        "comms_capability_denied",
    )
    _error(admin.post(first_path + "/restore"), 428, "comms_precondition_required")
    _error(
        admin.post(first_path + "/restore", headers={"If-Match": _tag(current)}),
        412,
        "comms_precondition_failed",
    )
    assert _snapshot(case) == before
    for target in (first_path, restricted_path):
        restored = admin.post(target + "/restore", headers={"If-Match": _tag(_read(admin, target))})
        assert _ok(restored)["archived_at"] is None
    assert _ok(peer.get(collection, params=query))["pagination"]["total"] == 3
    assert _ok(peer.get(collection, params=query | {"archived": "true"}))["items"] == []
    _error(peer.get(hidden_path), 404, "comms_not_found")
    with case.world.session(org) as db:
        assert db.get(CommsConversation, UUID(hidden["id"])).archived_at is not None
