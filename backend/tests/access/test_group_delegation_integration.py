"""Department managers change the members of their groups (slice 3d, D14).

A non-guest active user with ``manage`` on every department that a group's
access rows reach may replace its members. Everything else about groups stays
administrator-only.
"""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.systems.access.policy.models import Group, GroupMember
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.sandbox.modules.models import Module
from tests.access.group_delegation_support import DelegationWorld
from tests.access.group_delegation_support import world as world
from tests.conftest import membership_of
from tests.rbac.support import add_user

pytestmark = pytest.mark.integration


def _etag(group: Group) -> str:
    return f'"{group.id}:{group.revision}"'


def _put_members(
    world: DelegationWorld, user: User, group: Group, member_ids: list, etag: str | None
):
    headers = {} if etag is None else {"If-Match": etag}
    return world.client(user).put(
        f"/api/access/groups/{group.id}/members",
        json={"member_ids": [str(item) for item in member_ids]},
        headers=headers,
    )


@pytest.mark.parametrize("target", ["inventory_group", "module_group", "manager_group"])
def test_inventory_manager_replaces_members_of_groups_inside_inventory(
    world: DelegationWorld, target: str
) -> None:
    """A department row, a module row and a group that grants manage all stay inside."""

    group: Group = getattr(world, target)
    desired = [world.guest.id, world.pending.id]

    response = _put_members(world, world.manager, group, desired, _etag(group))

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body["member_ids"]) == {str(item) for item in desired}
    assert body["revision"] == 2
    assert response.headers["ETag"] == f'"{group.id}:2"'
    assert world.members(group) == set(desired)


def test_manager_may_remove_themselves_from_the_group_that_makes_them_a_manager(
    world: DelegationWorld,
) -> None:
    group = world.manager_group

    response = _put_members(world, world.manager, group, [world.guest_manager.id], _etag(group))

    assert response.status_code == 200, response.text
    assert world.members(group) == {world.guest_manager.id}


@pytest.mark.parametrize("target", ["mixed_group", "empty_group"])
def test_manager_cannot_see_or_change_a_group_outside_their_departments(
    world: DelegationWorld, target: str
) -> None:
    group: Group = getattr(world, target)
    before = world.members(group)

    replaced = _put_members(world, world.manager, group, [world.guest.id], _etag(group))
    detail = world.client(world.manager).get(f"/api/access/groups/{group.id}")

    assert replaced.status_code == 403
    assert detail.status_code == 404
    assert world.members(group) == before


def test_manager_lists_only_the_groups_they_may_change(world: DelegationWorld) -> None:
    response = world.client(world.manager).get("/api/access/groups", params={"limit": 100})

    assert response.status_code == 200, response.text
    assert {item["id"] for item in response.json()["items"]} == {
        str(world.inventory_group.id),
        str(world.module_group.id),
        str(world.manager_group.id),
    }
    groups = {item["id"]: item for item in response.json()["items"]}
    department_access = groups[str(world.inventory_group.id)]["access"][0]
    assert department_access["department_name"] == world.inventory.department_name
    assert department_access["module_name"] is None
    module_access = groups[str(world.module_group.id)]["access"][0]
    assert module_access["department_name"] == world.inventory.department_name
    module = world.db.get(Module, module_access["module_id"])
    assert module is not None
    assert module_access["module_name"] == module.module_name

    page = world.client(world.manager).get(
        "/api/access/groups", params={"search": world.module_group.name, "limit": 1}
    )
    assert page.status_code == 200
    assert page.json()["pagination"]["total"] == 1
    assert page.json()["items"][0]["access"] == [module_access]


def test_manager_cannot_rename_a_group_or_change_its_access(world: DelegationWorld) -> None:
    group = world.inventory_group
    client = world.client(world.manager)

    renamed = client.patch(
        f"/api/access/groups/{group.id}",
        json={"name": "Renamed"},
        headers={"If-Match": _etag(group)},
    )
    widened = client.put(
        f"/api/access/groups/{group.id}/access",
        json={"access": [{"department_id": str(world.finance.id), "level": "manage"}]},
        headers={"If-Match": _etag(group)},
    )

    assert (renamed.status_code, widened.status_code) == (403, 403)


def test_guest_holding_a_manage_row_is_not_a_manager(world: DelegationWorld) -> None:
    group = world.inventory_group

    replaced = _put_members(world, world.guest_manager, group, [], _etag(group))
    listed = world.client(world.guest_manager).get("/api/access/groups")
    candidates = world.client(world.guest_manager).get("/api/access/member-candidates")

    assert (replaced.status_code, listed.status_code, candidates.status_code) == (403, 403, 403)
    assert world.members(group) == {world.plain.id}


def test_member_without_manage_is_refused_every_group_route(world: DelegationWorld) -> None:
    client = world.client(world.plain)

    assert client.get("/api/access/groups").status_code == 403
    assert client.get(f"/api/access/groups/{world.inventory_group.id}").status_code == 403
    assert client.get("/api/access/member-candidates").status_code == 403
    assert (
        _put_members(
            world, world.plain, world.inventory_group, [], _etag(world.inventory_group)
        ).status_code
        == 403
    )


def test_manager_cannot_add_an_administrator(world: DelegationWorld) -> None:
    group = world.inventory_group

    response = _put_members(world, world.manager, group, [world.other_admin.id], _etag(group))

    assert response.status_code == 409
    assert world.members(group) == {world.plain.id}


def test_manager_keeps_members_who_became_disabled_or_expired(world: DelegationWorld) -> None:
    group = world.inventory_group
    expired = add_user(world.db, "delegation-expired", role=UserRole.GUEST)
    world.db.add(GroupMember(org_id=group.org_id, group_id=group.id, user_id=expired.id))
    world.plain.status = UserStatus.DISABLED
    membership_of(world.db, expired.id).expires_at = datetime.now(UTC) - timedelta(days=1)
    world.db.commit()

    response = _put_members(
        world, world.manager, group, [world.plain.id, expired.id, world.guest.id], _etag(group)
    )

    assert response.status_code == 200, response.text
    assert world.members(group) == {world.plain.id, expired.id, world.guest.id}


def test_manager_cannot_add_a_disabled_or_expired_user(world: DelegationWorld) -> None:
    group = world.inventory_group
    disabled = add_user(world.db, "delegation-disabled", status=UserStatus.DISABLED)
    expired = add_user(
        world.db,
        "delegation-expired",
        role=UserRole.GUEST,
        expires_at=datetime.now(UTC) - timedelta(days=1),
    )
    world.db.commit()

    responses = [
        _put_members(world, world.manager, group, [world.plain.id, item.id], _etag(group))
        for item in (disabled, expired)
    ]

    assert [item.status_code for item in responses] == [409, 409]
    assert world.members(group) == {world.plain.id}


@pytest.mark.parametrize(("etag", "status_code"), [('"stale:1"', 412), (None, 428)])
def test_member_replacement_requires_the_current_version(
    world: DelegationWorld, etag: str | None, status_code: int
) -> None:
    group = world.inventory_group

    response = _put_members(world, world.manager, group, [world.guest.id], etag)

    assert response.status_code == status_code
    assert world.members(group) == {world.plain.id}


def test_administrator_replaces_members_of_any_group(world: DelegationWorld) -> None:
    group = world.mixed_group

    response = _put_members(world, world.admin, group, [world.pending.id], _etag(group))

    assert response.status_code == 200, response.text
    assert world.members(group) == {world.pending.id}


def test_group_patch_no_longer_accepts_members(world: DelegationWorld) -> None:
    group = world.inventory_group

    response = world.client(world.admin).patch(
        f"/api/access/groups/{group.id}",
        json={"member_ids": [str(world.guest.id)]},
        headers={"If-Match": _etag(group)},
    )

    assert response.status_code == 422
    assert world.members(group) == {world.plain.id}


def test_member_candidates_are_the_non_administrator_accounts(world: DelegationWorld) -> None:
    deleted = add_user(world.db, "delegation-deleted")
    deleted.is_deleted = True
    world.db.flush()

    response = world.client(world.manager).get(
        "/api/access/member-candidates", params={"search": "delegation-", "limit": 100}
    )

    assert response.status_code == 200, response.text
    items = {item["id"]: item for item in response.json()["items"]}
    assert {str(world.plain.id), str(world.guest.id), str(world.pending.id)} <= set(items)
    assert str(world.admin.id) not in items
    assert str(world.other_admin.id) not in items
    assert str(deleted.id) not in items
    assert set(items[str(world.pending.id)]) == {
        "id",
        "display_name",
        "username",
        "email",
        "role",
        "status",
        "access_ends_at",
    }
    assert items[str(world.pending.id)]["status"] == "pending"
    assert items[str(world.pending.id)]["access_ends_at"] is None
    assert world.client(world.admin).get("/api/access/member-candidates").status_code == 200


def test_administrator_lists_member_candidates_when_no_group_exists(world: DelegationWorld) -> None:
    for group in world.db.scalars(select(Group).where(Group.is_deleted.is_(False))).all():
        group.is_deleted = True
    world.db.commit()

    response = world.client(world.admin).get(
        "/api/access/member-candidates", params={"search": "delegation-plain"}
    )
    refused = world.client(world.manager).get("/api/access/member-candidates")

    assert response.status_code == 200, response.text
    assert [item["id"] for item in response.json()["items"]] == [str(world.plain.id)]
    assert refused.status_code == 403
