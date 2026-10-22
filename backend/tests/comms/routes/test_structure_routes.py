"""Channel/category creation and conditional category configuration through real HTTP."""

from threading import Barrier
from uuid import UUID

import pytest

from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.comms.conversations.models import CommsCategory
from app.systems.comms.settings.models import CommsCapabilityGrant
from app.systems.sandbox.departments.models import Department
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
        # D44 A8: organization channels need a category without a department.
        open_category = CommsCategory(org_id=org.id, name="Organization", position=1)
        # A createChannel grant reaches only departments where the creator holds a role.
        creators = Group(org_id=org.id, name="Department readers")
        db.add_all([open_category, creators])
        db.flush()
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(GroupMember(org_id=org.id, group_id=creators.id, user_id=org.peer))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=creators.id, department_id=org.department, level="read"
            )
        )
        for category in (org.category, open_category.id):
            db.add(
                CommsCapabilityGrant(
                    org_id=org.id,
                    scope="category",
                    category_id=category,
                    subject="group",
                    group_id=org.group,
                    capability="createChannel",
                    granted=True,
                )
            )
        open_category_id = open_category.id
        db.commit()
    assert _creation(case, org.peer, org.category) is True
    assert _creation(case, org.peer) is False
    _error(
        creator.post(collection, json=_channel("No workspace right")),
        403,
        "comms_capability_denied",
    )
    _error(
        creator.post(collection, json=_channel("Public", open_category_id)),
        403,
        "comms_capability_denied",
    )
    public, public_path = _created(admin, collection, _channel("Public", open_category_id))
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
    assert all(row["level"] == "manage" for row in (public, department))
    assert department["department_id"] == str(org.department)
    assert "department_id" not in public
    assert _ok(observer.get(public_path))["level"] == "post"
    _error(observer.get(department_path), 404, "comms_not_found")
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=foreign.author))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=org.group, department_id=org.department, level="read"
            )
        )
        db.commit()
    assert _ok(observer.get(department_path))["level"] == "read"
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
        (_channel("Injected", org.category) | {"org_id": str(foreign.id)}, 422),
    ):
        _error(admin.post(collection, json=payload), status)
        assert _snapshot(case) == before
    _error(admin.get(f"{ROOT}/categories/{foreign.category}"), 404, "comms_not_found")
    neighbour = case.client(foreign.author, foreign.id)
    assert _ok(neighbour.get(f"{ROOT}/categories/{foreign.category}"))["org_id"] == str(foreign.id)


def test_category_and_channel_competing_etags_preserve_complete_changes(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    categories = f"{ROOT}/categories"
    body = {"name": "Creation defaults", "position": 3, "department_id": None}
    created = admin.post(categories, json=body)
    category = _ok(created, 201)
    path = f"{categories}/{category['id']}"
    assert created.headers["location"] == path
    current = _read(admin, path)
    _ok(admin.put(path, headers={"If-Match": _tag(current)}, json=body | {"position": 4}))
    body["position"] = 4
    copied, copied_path = _created(
        admin, f"{ROOT}/conversations", _channel("Copied defaults", category["id"])
    )
    assert _ok(peer.get(copied_path))["level"] == "post"
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
            },
        ),
        403,
        "comms_capability_denied",
    )


def test_d44_refuses_admissions_group_access_hand_picked_channels_and_their_settings(
    structure_routes,
):
    case, org = structure_routes, structure_routes.world.first
    admin = case.client(org.author, org.id)
    channel = f"{ROOT}/conversations/{org.conversation}"
    item = f"{channel}/admissions/{org.other_conversation}"
    before = _snapshot(case)
    for method, path, body in (
        ("GET", channel + "/admissions", None),
        ("GET", item, None),
        ("POST", item + "/decision", {"decision": "accept"}),
        ("POST", channel + "/invitations", {"user_id": str(org.peer)}),
        ("POST", f"{ROOT}/join-requests", {"conversation_id": str(org.conversation)}),
        ("PUT", channel + "/access", {"access": []}),
    ):
        _error(admin.request(method, path, json=body), 404)
    for payload in (
        _channel("Shared", scope="groups", access=[{"subject": "everyone", "level": "read"}]),
        _channel("Hand-picked", scope="members", member_ids=[str(org.peer)]),
    ):
        _error(admin.post(f"{ROOT}/conversations", json=payload), 422)
    category = {"name": "Defaults", "position": 1, "department_id": None, "default_access": []}
    _error(admin.post(f"{ROOT}/categories", json=category), 422)
    settings = f"{ROOT}/settings/workspace"
    for values in ({"join_rule": "request"}, {"default_member_ids": [str(org.peer)]}):
        _error(admin.patch(settings, json=values), 422)
    for key in ("join_rule", "default_member_ids"):
        _error(admin.put(settings + "/locks", json={"keys": [key]}), 422)
    assert _snapshot(case) == before


def test_d44_category_department_binds_create_move_and_duplicate(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    admin = case.client(org.author, org.id)
    collection = f"{ROOT}/conversations"
    with case.world.session(org) as db:
        other = Department(org_id=org.id, department_name="Unbound department")
        db.add(other)
        db.flush()
        other_department = str(other.id)
        db.commit()
    open_category = {"name": "Organization", "position": 1, "department_id": None}
    bound = str(org.category)
    unbound = _ok(admin.post(f"{ROOT}/categories", json=open_category), 201)["id"]

    def department(name, category, identity=str(org.department)):
        return _channel(name, category, "department", department_id=identity)

    before = _snapshot(case)
    for payload in (
        _channel("Organization in department category", bound),
        department("Department in organization category", unbound),
        department("Other department in category", bound, other_department),
    ):
        _error(admin.post(collection, json=payload), 422, "comms_invalid")
    assert _snapshot(case) == before
    _, in_bound = _created(admin, collection, department("Bound", bound))
    _, in_unbound = _created(admin, collection, _channel("Unbound", unbound))
    _, loose = _created(admin, collection, department("Uncategorized", None))
    before = _snapshot(case)
    for path, category in ((in_unbound, bound), (in_bound, unbound), (loose, unbound)):
        _error(
            admin.patch(
                path, headers={"If-Match": _tag(_read(admin, path))}, json={"category_id": category}
            ),
            422,
            "comms_invalid",
        )
    for path, category in ((in_bound, unbound), (in_unbound, bound)):
        _error(
            admin.post(
                path + "/duplicates",
                headers={"If-Match": _tag(_read(admin, path))},
                json={"name": "Copy", "category_id": category},
            ),
            422,
            "comms_invalid",
        )
    assert _snapshot(case) == before
    moved = admin.patch(
        loose, headers={"If-Match": _tag(_read(admin, loose))}, json={"category_id": bound}
    )
    assert _ok(moved)["category_id"] == bound
    copy = admin.post(
        in_unbound + "/duplicates",
        headers={"If-Match": _tag(_read(admin, in_unbound))},
        json={"name": "Unbound copy", "category_id": unbound},
    )
    assert (_ok(copy, 201)["scope"], copy.json()["category_id"]) == ("organization", unbound)


def test_d44_department_manager_creates_only_channels_of_managed_departments(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    manager = case.client(org.peer, org.id)
    collection = f"{ROOT}/conversations"
    with case.world.session(org) as db:
        other = Department(org_id=org.id, department_name="Unmanaged department")
        db.add(other)
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=org.group, department_id=org.department, level="manage"
            )
        )
        db.flush()
        other_department = str(other.id)
        db.commit()
    for category in (None, org.category):
        row, _ = _created(
            manager,
            collection,
            _channel("Managed", category, "department", department_id=str(org.department)),
        )
        assert (row["level"], row["department_id"]) == ("manage", str(org.department))
    before = _snapshot(case)
    for payload in (
        _channel("Unmanaged", None, "department", department_id=other_department),
        _channel("Organization"),
    ):
        _error(manager.post(collection, json=payload), 403, "comms_capability_denied")
    assert _snapshot(case) == before


def test_d44_category_rebind_refuses_channels_of_another_department(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    admin = case.client(org.author, org.id)
    body = {"name": "Rebind", "position": 1, "department_id": None}
    category = _ok(admin.post(f"{ROOT}/categories", json=body), 201)
    path = f"{ROOT}/categories/{category['id']}"
    _, channel = _created(admin, f"{ROOT}/conversations", _channel("Held", category["id"]))
    bound = body | {"department_id": str(org.department)}
    before = _snapshot(case)
    _error(
        admin.put(path, headers={"If-Match": _tag(_read(admin, path))}, json=bound),
        422,
        "comms_invalid",
    )
    assert _snapshot(case) == before
    renamed = admin.put(
        path, headers={"If-Match": _tag(_read(admin, path))}, json=body | {"name": "Renamed"}
    )
    assert _ok(renamed)["name"] == "Renamed"
    _ok(
        admin.patch(
            channel, headers={"If-Match": _tag(_read(admin, channel))}, json={"category_id": None}
        )
    )
    rebound = admin.put(path, headers={"If-Match": _tag(_read(admin, path))}, json=bound)
    assert _ok(rebound)["department_id"] == str(org.department)


def test_d44_create_channel_grant_reaches_only_departments_with_a_role(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    member = case.client(org.peer, org.id)
    collection = f"{ROOT}/conversations"
    with case.world.session(org) as db:
        finance = Department(org_id=org.id, department_name="Finance")
        db.add(finance)
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=org.group, department_id=org.department, level="read"
            )
        )
        db.flush()
        finance_id = str(finance.id)
        db.commit()
    sales = _channel("Sales", None, "department", department_id=str(org.department))
    before = _snapshot(case)
    _error(member.post(collection, json=sales), 403, "comms_capability_denied")
    assert _snapshot(case) == before
    with case.world.session(org) as db:
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
    # Owner decision 2026-10-22: a createChannel grant reaches only departments where the
    # member holds a department role; it never creates an organization channel.
    row, _ = _created(member, collection, sales)
    assert (row["scope"], row["department_id"], row["level"]) == (
        "department",
        str(org.department),
        "manage",
    )
    before = _snapshot(case)
    for payload in (
        _channel("Finance", None, "department", department_id=finance_id),
        _channel("Organization"),
    ):
        _error(member.post(collection, json=payload), 403, "comms_capability_denied")
    assert _snapshot(case) == before
