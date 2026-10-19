"""Channel/category creation and conditional category configuration through real HTTP."""

from threading import Barrier
from uuid import UUID

import pytest

from app.systems.access.policy.models import GroupAccess, GroupMember
from app.systems.comms.conversations.models import CommsCategory
from app.systems.comms.settings.models import CommsCapabilityGrant
from tests.comms.routes.structure_support import (
    ROOT,
    _channel,
    _created,
    _creation,
    _error,
    _ok,
    _race,
    _read,
    _snapshot,
    _tag,
    _unchanged_read,
)

pytestmark = pytest.mark.integration


def test_creation_rechecks_target_capability_scope_and_foreign_references(structure_routes):
    case, org, foreign = (
        structure_routes,
        structure_routes.world.first,
        structure_routes.world.second,
    )
    case.add_home_members(foreign.author)
    creator, admin = case.client(org.peer, org.id), case.client(org.author, org.id)
    observer = case.client(foreign.author, org.id)
    collection = f"{ROOT}/conversations"
    before = _snapshot(case)
    _error(
        creator.post(collection, json=_channel("Public", org.category)),
        403,
        "comms_capability_denied",
    )
    assert _snapshot(case) == before
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            CommsCapabilityGrant(
                org_id=org.id,
                scope="category",
                category_id=org.category,
                subject="group",
                group_id=org.group,
                capability="createChannel",
                granted=True,
            )
        )
        db.commit()
    assert _creation(case, org.peer, org.category) is True
    assert _creation(case, org.peer) is False
    _error(
        creator.post(collection, json=_channel("No workspace right")),
        403,
        "comms_capability_denied",
    )
    public, public_path = _created(creator, collection, _channel("Public", org.category))
    department, department_path = _created(
        creator,
        collection,
        _channel(
            "Department",
            org.category,
            "department",
            department_id=str(org.department),
        ),
    )
    private, private_path = _created(
        creator,
        collection,
        _channel(
            "Private",
            org.category,
            "members",
            member_ids=[],
        ),
    )
    assert all(row["level"] == "manage" for row in (public, department, private))
    assert department["department_id"] == str(org.department)
    assert "department_id" not in public and "member_ids" not in private
    assert _ok(observer.get(public_path))["level"] == "post"
    _error(observer.get(department_path), 404, "comms_not_found")
    _error(observer.get(private_path), 404, "comms_not_found")
    _error(admin.get(private_path), 404, "comms_not_found")  # D43, despite organization admin.
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=foreign.author))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=org.group, department_id=org.department, level="read"
            )
        )
        db.commit()
    assert _ok(observer.get(department_path))["level"] == "read"
    _error(observer.get(private_path), 404, "comms_not_found")
    before = _snapshot(case)
    for payload, status in (
        (_channel("Foreign category", foreign.category), 404),
        (
            _channel(
                "Foreign department",
                org.category,
                "department",
                department_id=str(foreign.department),
            ),
            404,
        ),
        (
            _channel(
                "Foreign group",
                org.category,
                "groups",
                access=[
                    {"subject": "group", "group_id": str(foreign.group), "level": "read"},
                ],
            ),
            422,
        ),
        (_channel("Foreign person", org.category, "members", member_ids=[str(foreign.peer)]), 404),
        (_channel("Injected", org.category) | {"org_id": str(foreign.id)}, 422),
    ):
        _error(admin.post(collection, json=payload), status)
        assert _snapshot(case) == before
    _error(admin.get(f"{ROOT}/categories/{foreign.category}"), 404, "comms_not_found")
    neighbour = case.client(foreign.author, foreign.id)
    assert _ok(neighbour.get(f"{ROOT}/categories/{foreign.category}"))["org_id"] == str(foreign.id)


def test_category_copy_empty_access_and_competing_etags_preserve_complete_changes(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    categories = f"{ROOT}/categories"
    body = {
        "name": "Creation defaults",
        "position": 3,
        "department_id": None,
        "default_access": [{"subject": "everyone", "level": "read"}],
    }
    created = admin.post(categories, json=body)
    category = _ok(created, 201)
    path = f"{categories}/{category['id']}"
    assert created.headers["location"] == path
    current = _read(admin, path)
    copied, copied_path = _created(
        admin,
        f"{ROOT}/conversations",
        _channel(
            "Copied defaults",
            category["id"],
            "groups",
            access=current.json()["default_access"],
        ),
    )
    assert copied["access"] == body["default_access"]
    _ok(
        admin.put(
            path,
            headers={"If-Match": _tag(current)},
            json=body
            | {
                "default_access": [{"subject": "everyone", "level": "post"}],
            },
        )
    )
    assert _ok(peer.get(copied_path))["level"] == "read"
    assert _ok(admin.get(copied_path))["access"] == body["default_access"]
    empty, empty_path = _created(
        admin,
        f"{ROOT}/conversations",
        _channel(
            "Explicit empty",
            category["id"],
            "groups",
            access=[],
        ),
    )
    assert empty["access"] == []
    _error(peer.get(empty_path), 404, "comms_not_found")
    before = _snapshot(case)
    current = _read(admin, copied_path)
    _unchanged_read(admin, copied_path, current)
    _error(
        admin.patch(copied_path, json={"topic": "Missing version"}),
        428,
        "comms_precondition_required",
    )
    assert _snapshot(case) == before
    gate = Barrier(2)
    left, right = (
        case.client(org.author, org.id, request_gate=gate),
        case.client(
            org.author,
            org.id,
            request_gate=gate,
        ),
    )
    patches = [{"name": "Editor A", "topic": "Whole A"}, {"name": "Editor B", "topic": "Whole B"}]
    outcomes = _race(
        lambda: left.patch(copied_path, headers={"If-Match": _tag(current)}, json=patches[0]),
        lambda: right.patch(copied_path, headers={"If-Match": _tag(current)}, json=patches[1]),
    )
    assert sorted(response.status_code for response in outcomes) == [200, 412]
    winner = next(i for i, response in enumerate(outcomes) if response.status_code == 200)
    committed = _read(admin, copied_path)
    assert {key: committed.json()[key] for key in ("name", "topic")} == patches[winner]
    assert _tag(committed) != _tag(current)
    before = _snapshot(case)
    _error(
        admin.patch(copied_path, headers={"If-Match": _tag(current)}, json=patches[1 - winner]),
        412,
        "comms_precondition_failed",
    )
    _error(admin.put(path, json=body), 428, "comms_precondition_required")
    _error(
        admin.put(path, headers={"If-Match": _tag(created)}, json=body),
        412,
        "comms_precondition_failed",
    )
    _error(
        peer.put(path, headers={"If-Match": _tag(_read(admin, path))}, json=body),
        403,
        "comms_capability_denied",
    )
    assert _snapshot(case) == before
    first = _ok(admin.get(categories, params={"limit": 1, "sort_by": "position"}))
    second = _ok(admin.get(categories, params={"limit": 1, "offset": 1, "sort_by": "position"}))
    assert [row["id"] for row in first["items"]] == [str(org.category)]
    assert [row["id"] for row in second["items"]] == [category["id"]]
    assert first["pagination"] == {
        "limit": 1,
        "offset": 0,
        "count": 1,
        "total": 2,
        "has_more": True,
    }
    assert second["pagination"] == {
        "limit": 1,
        "offset": 1,
        "count": 1,
        "total": 2,
        "has_more": False,
    }
    assert _ok(admin.get(categories, params={"search": "Creation"}))["pagination"]["total"] == 1


def test_category_manager_may_unlink_without_retaining_management(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    body = {
        "name": "Managed category",
        "position": 1,
        "department_id": str(org.department),
        "default_access": [],
    }
    row = _ok(admin.post(f"{ROOT}/categories", json=body), 201)
    path = f"{ROOT}/categories/{row['id']}"
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=org.group, department_id=org.department, level="manage"
            )
        )
        db.commit()
    current = _read(peer, path)
    detached = peer.put(
        path, headers={"If-Match": _tag(current)}, json=body | {"department_id": None}
    )
    assert _ok(detached)["department_id"] is None
    assert _tag(detached) != _tag(current)
    _unchanged_read(admin, path, detached)
    before = _snapshot(case)
    _error(
        peer.put(path, headers={"If-Match": _tag(detached)}, json=body),
        403,
        "comms_capability_denied",
    )
    assert _snapshot(case) == before
    with case.world.session(org) as db:
        assert db.get(CommsCategory, UUID(row["id"])).department_id is None


def test_category_creation_uses_workspace_creation_capability_not_workspace_management(
    structure_routes,
):
    case, org = structure_routes, structure_routes.world.first
    actor = case.client(org.peer, org.id)
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
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
    row = _ok(
        actor.post(
            ROOT + "/categories",
            json={
                "name": "Delegated creation",
                "position": 0,
                "department_id": None,
                "default_access": [],
            },
        ),
        201,
    )
    path = ROOT + "/categories/" + row["id"]
    current = _read(actor, path)
    assert current.json()["name"] == "Delegated creation"
    # createChannel does not silently acquire manageWorkspace or category management.
    _error(
        actor.put(
            path,
            headers={"If-Match": _tag(current)},
            json={
                "name": "No management grant",
                "position": 0,
                "department_id": None,
                "default_access": [],
            },
        ),
        403,
        "comms_capability_denied",
    )
