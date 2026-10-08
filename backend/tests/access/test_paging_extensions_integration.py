"""D22 filters apply before pagination without widening Access visibility."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from uuid6 import uuid7

from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.access.users.router import router as users_router
from app.systems.sandbox.modules.models import Module
from tests.access.test_group_delegation_integration import world as world
from tests.rbac.support import add_module, add_user

pytestmark = pytest.mark.integration


@pytest.fixture
def paging_world(world):
    world._client.app.include_router(users_router, prefix="/api")
    return world


@pytest.fixture
def group_page(paging_world):
    world = paging_world
    marker = f"paging-{uuid7().hex}"
    groups = {
        name: Group(name=f"{marker} {name}")
        for name in ("empty", "member", "access", "both", "removed")
    }
    world.db.add_all(groups.values())
    world.db.flush()
    for name, members in (("member", [world.plain]), ("both", [world.plain, world.guest])):
        for user in members:
            world.db.add(GroupMember(group_id=groups[name].id, user_id=user.id))
    module = world.db.scalar(select(Module).where(Module.department_id == world.inventory.id))
    for name, module_id, deleted in (
        ("access", None, False),
        ("both", None, False),
        ("both", module.id, False),
        ("removed", None, True),
    ):
        world.db.add(
            GroupAccess(
                group_id=groups[name].id,
                department_id=world.inventory.id,
                module_id=module_id,
                level="read",
                is_deleted=deleted,
            )
        )
    world.db.commit()
    return world, marker, groups, module


def test_group_filters_and_member_sort_apply_before_the_page(group_page):
    world, marker, groups, _module = group_page
    client = world.client(world.admin)
    for filters, names in (
        ({"without_access": "true"}, {"empty", "member", "removed"}),
        ({"without_members": "true"}, {"empty", "access", "removed"}),
        ({"without_access": "true", "without_members": "true"}, {"empty", "removed"}),
        ({"without_access": "false", "without_members": "false"}, set(groups)),
    ):
        response = client.get(
            "/api/access/groups", params={"search": marker, "limit": 100, **filters}
        )
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "private, no-store"
        body = response.json()
        assert body["pagination"]["total"] == len(names)
        assert {row["id"] for row in body["items"]} == {str(groups[name].id) for name in names}

    expected = [
        *sorted((groups["empty"], groups["access"], groups["removed"]), key=lambda row: row.id),
        groups["member"],
        groups["both"],
    ]
    pages = [
        client.get(
            "/api/access/groups",
            params={"search": marker, "sort_by": "member_count", "limit": 1, "offset": offset},
        )
        for offset in range(len(groups))
    ]
    assert all(response.status_code == 200 for response in pages)
    assert [response.json()["items"][0]["id"] for response in pages] == [
        str(row.id) for row in expected
    ]
    for offset, response in enumerate(pages):
        assert response.json()["pagination"] == {
            "limit": 1,
            "offset": offset,
            "count": 1,
            "total": 5,
            "has_more": offset < 4,
        }


def test_group_search_matches_access_names_once_and_keeps_manager_visibility(group_page):
    world, _marker, groups, module = group_page
    department_name = f"Department literal_% {uuid7().hex}"
    module_name = f"Module literal_% {uuid7().hex}"
    world.inventory.department_name = department_name
    module.module_name = module_name
    world.finance.department_name = department_name.replace("_%", "XY")
    decoy_module = add_module(world.db, world.finance)
    decoy_module.module_name = module_name.replace("_%", "XY")
    decoy = Group(name=f"Decoy {uuid7().hex}")
    world.db.add(decoy)
    world.db.flush()
    world.db.add(
        GroupAccess(
            group_id=decoy.id,
            department_id=world.finance.id,
            module_id=decoy_module.id,
            level="read",
        )
    )
    world.db.commit()
    for search, required in (
        (department_name.swapcase(), {"access", "both"}),
        (module_name.swapcase(), {"both"}),
    ):
        response = world.client(world.admin).get(
            "/api/access/groups", params={"search": search, "limit": 100}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        matching = {str(groups[name].id) for name in required}
        assert matching <= {row["id"] for row in body["items"]}
        assert str(decoy.id) not in {row["id"] for row in body["items"]}
        assert str(groups["removed"].id) not in {row["id"] for row in body["items"]}
        assert len(body["items"]) == body["pagination"]["total"]
        assert len({row["id"] for row in body["items"]}) == len(body["items"])
    forbidden_name = f"Unmanaged {uuid7().hex}"
    world.finance.department_name = forbidden_name
    world.db.commit()
    hidden = world.client(world.manager).get(
        "/api/access/groups", params={"search": forbidden_name}
    )
    assert hidden.status_code == 200
    assert hidden.json()["items"] == []
    assert hidden.json()["pagination"]["total"] == 0
    no_access = world.client(world.manager).get(
        "/api/access/groups", params={"without_access": "true"}
    )
    assert no_access.status_code == 200
    assert no_access.json()["items"] == []


def test_admin_ids_resolve_requested_deleted_people_and_preserve_list_state(paging_world):
    world = paging_world
    deleted = add_user(world.db, "paging-deleted")
    deleted.is_deleted = True
    deleted.deleted_at = datetime.now(UTC)
    world.db.commit()
    ids = [world.plain.id, deleted.id, *[uuid7() for _ in range(98)]]
    response = world.client(world.admin).get(
        "/api/users", params=[("ids", str(value)) for value in ids] + [("limit", "100")]
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["pagination"]["total"] == body["pagination"]["count"] == 2
    rows = {row["id"]: row for row in body["items"]}
    assert set(rows) == {str(world.plain.id), str(deleted.id)}
    assert rows[str(deleted.id)]["is_deleted"] is True
    assert rows[str(deleted.id)]["deleted_at"] is not None
    assert rows[str(world.plain.id)]["is_deleted"] is False
    repeated = world.client(world.admin).get(
        "/api/users", params=[("ids", str(world.plain.id)), ("ids", str(world.plain.id))]
    )
    assert repeated.json()["pagination"]["total"] == 1
    assert [row["id"] for row in repeated.json()["items"]] == [str(world.plain.id)]
    only_deleted = world.client(world.admin).get(
        "/api/users", params=[("ids", str(value)) for value in ids[:2]] + [("deleted", "only")]
    )
    assert [row["id"] for row in only_deleted.json()["items"]] == [str(deleted.id)]
    normal = world.client(world.admin).get("/api/users", params={"limit": 100})
    assert str(deleted.id) not in {row["id"] for row in normal.json()["items"]}
    denied = world.client(world.manager).get("/api/users", params={"ids": str(deleted.id)})
    assert denied.status_code == 403


def test_candidate_ids_keep_the_manager_boundary_and_report_recorded_expiry(paging_world):
    world = paging_world
    world.guest.expires_at = datetime.now(UTC) - timedelta(days=1)
    world.plain.is_deleted = True
    world.plain.deleted_at = datetime.now(UTC)
    world.db.commit()
    requested = [world.guest.id, world.plain.id, world.admin.id, uuid7()]
    response = world.client(world.manager).get(
        "/api/access/member-candidates", params=[("ids", str(value)) for value in requested]
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["pagination"]["total"] == 1
    assert [row["id"] for row in body["items"]] == [str(world.guest.id)]
    assert datetime.fromisoformat(body["items"][0]["access_ends_at"]) == world.guest.expires_at
    world.manager.status = "disabled"
    world.db.commit()
    denied = world.client(world.manager).get(
        "/api/access/member-candidates", params={"ids": str(world.guest.id)}
    )
    assert denied.status_code == 403


@pytest.mark.parametrize("path", ["/api/users", "/api/access/member-candidates"])
@pytest.mark.parametrize("kind", ["over_limit", "malformed", "empty"])
def test_ids_validation_rejects_unbounded_or_invalid_lookup(paging_world, path, kind):
    world = paging_world
    values = (
        [str(world.plain.id)] * 101
        if kind == "over_limit"
        else ["invalid" if kind == "malformed" else ""]
    )
    response = world.client(world.admin).get(path, params=[("ids", value) for value in values])
    assert response.status_code == 422, response.text


def test_group_member_lookup_pages_all_memberships_including_no_access_groups(paging_world):
    world = paging_world
    marker = f"membership-{uuid7().hex}"
    matching = [Group(name=f"{marker} {index:02d}") for index in range(27)]
    decoy = Group(name=f"{marker} decoy")
    world.db.add_all([*matching, decoy])
    world.db.flush()
    for group in matching:
        world.db.add(GroupMember(group_id=group.id, user_id=world.plain.id))
    for group in (matching[-1], decoy):
        world.db.add(GroupMember(group_id=group.id, user_id=world.guest.id))
    world.db.commit()
    client = world.client(world.admin)
    params = {
        "search": marker,
        "member_id": str(world.plain.id),
        "sort_by": "member_count",
    }

    pages = [
        client.get("/api/access/groups", params={**params, "offset": offset}) for offset in (0, 25)
    ]

    assert all(response.status_code == 200 for response in pages)
    expected = [*sorted(matching[:-1], key=lambda group: group.id), matching[-1]]
    assert [row["id"] for response in pages for row in response.json()["items"]] == [
        str(group.id) for group in expected
    ]
    for response, offset, count, has_more in zip(
        pages, (0, 25), (25, 2), (True, False), strict=True
    ):
        body = response.json()
        assert body["pagination"] == {
            "limit": 25,
            "offset": offset,
            "count": count,
            "total": 27,
            "has_more": has_more,
        }
        assert response.headers["cache-control"] == "private, no-store"
        assert all(
            str(world.plain.id) in row["member_ids"] and row["access"] == []
            for row in body["items"]
        )
    beyond = client.get("/api/access/groups", params={**params, "offset": 27}).json()
    assert beyond["items"] == []
    assert beyond["pagination"]["total"] == 27
    assert beyond["pagination"]["has_more"] is False
    default = client.get("/api/access/groups", params={"search": marker, "limit": 100}).json()
    assert default["pagination"]["total"] == 28
    assert {row["id"] for row in default["items"]} == {
        str(group.id) for group in [*matching, decoy]
    }


def test_group_member_lookup_intersects_search_gaps_and_deleted_state(group_page):
    world, marker, groups, module = group_page
    client = world.client(world.admin)
    params = {
        "search": marker,
        "member_id": str(world.plain.id),
        "sort_by": "member_count",
        "sort_order": "desc",
    }
    pages = [
        client.get("/api/access/groups", params={**params, "limit": 1, "offset": offset})
        for offset in (0, 1)
    ]
    assert all(response.status_code == 200 for response in pages)
    assert [response.json()["items"][0]["id"] for response in pages] == [
        str(groups[name].id) for name in ("both", "member")
    ]
    assert all(response.json()["pagination"]["total"] == 2 for response in pages)
    for extra, expected in (
        ({"without_access": "true"}, [groups["member"]]),
        ({"without_members": "true"}, []),
        ({"search": f"{marker} empty"}, []),
        ({"search": module.module_name, "member_id": str(world.guest.id)}, [groups["both"]]),
        ({"member_id": str(uuid7())}, []),
    ):
        response = client.get("/api/access/groups", params={**params, **extra})
        assert response.status_code == 200, response.text
        body = response.json()
        assert [row["id"] for row in body["items"]] == [str(group.id) for group in expected]
        assert body["pagination"]["total"] == len(expected)
    groups["both"].is_deleted = True
    groups["both"].deleted_at = datetime.now(UTC)
    world.db.commit()
    for deleted, expected in (
        ("exclude", [groups["member"]]),
        ("include", [groups["both"], groups["member"]]),
        ("only", [groups["both"]]),
    ):
        response = client.get("/api/access/groups", params={**params, "deleted": deleted})
        assert response.status_code == 200, response.text
        assert [row["id"] for row in response.json()["items"]] == [
            str(group.id) for group in expected
        ]
        assert response.json()["pagination"]["total"] == len(expected)


def test_group_member_lookup_preserves_manager_scope_and_role_denials(paging_world):
    world = paging_world
    params = {"member_id": str(world.plain.id), "limit": 100}
    response = world.client(world.manager).get("/api/access/groups", params=params)
    assert response.status_code == 200, response.text
    assert {row["id"] for row in response.json()["items"]} == {
        str(world.inventory_group.id),
        str(world.module_group.id),
    }
    assert response.json()["pagination"]["total"] == 2
    admin = world.client(world.admin).get("/api/access/groups", params=params)
    assert admin.status_code == 200
    assert {row["id"] for row in admin.json()["items"]} == {
        str(group.id)
        for group in (
            world.inventory_group,
            world.module_group,
            world.mixed_group,
            world.empty_group,
        )
    }
    for actor in (world.plain, world.guest_manager):
        assert world.client(actor).get("/api/access/groups", params=params).status_code == 403


@pytest.mark.parametrize("member_id", ["invalid", ""])
def test_group_member_lookup_rejects_invalid_uuid(paging_world, member_id):
    response = paging_world.client(paging_world.admin).get(
        "/api/access/groups", params={"member_id": member_id}
    )
    assert response.status_code == 422, response.text
