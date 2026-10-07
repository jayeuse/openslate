"""Access HTTP writes notify effective deltas, never raw rows or lifecycle-only changes."""

import pytest
from sqlalchemy import select

from app.systems.access.policy.models import AccessLevel, Group, GroupMember
from app.systems.access.users.models import UserRole, UserStatus
from app.systems.platform.scheduling.models import InAppNotification
from app.systems.platform.scheduling.notification_router import router as notification_router
from tests.access.test_user_admin_http_integration import world as world
from tests.rbac.support import add_module, add_user, make_group_access

pytestmark = pytest.mark.integration


def _notices(world, user):
    return list(
        world.db.scalars(
            select(InAppNotification).where(
                InAppNotification.recipient_id == user.id,
                InAppNotification.kind == "access-changed",
            )
        )
    )


def _members(world, group, members, status=200, etag=None):
    response = world.client(world.admin).put(
        f"/api/access/groups/{group.id}/members",
        json={"member_ids": [str(u.id) for u in members]},
        headers={"If-Match": etag or f'"{group.id}:{group.revision}"'},
    )
    assert response.status_code == status, response.text
    return response


def _access(world, group, entries, status=200):
    response = world.client(world.admin).put(
        f"/api/access/groups/{group.id}/access",
        json={"access": entries},
        headers={"If-Match": f'"{group.id}:{group.revision}"'},
    )
    assert response.status_code == status, response.text
    return response


def test_membership_effective_gain_loss_noops_and_redundant_group_removal(world):
    world._client.app.include_router(notification_router, prefix="/api")
    group, member = world.group, world.member
    _members(world, group, [world.colleague, member])
    assert len(_notices(world, member)) == 1
    _members(world, group, [member, world.colleague])
    assert len(_notices(world, member)) == 1
    stronger = make_group_access(world.db, [member], world.inventory, level=AccessLevel.MANAGE)
    world.db.commit()
    _members(world, group, [world.colleague])
    assert len(_notices(world, member)) == 1
    stronger_group = world.db.get(Group, stronger.group_id)
    _members(world, stronger_group, [])
    notices = _notices(world, member)
    assert len(notices) == 2
    assert all(
        n.subject_type == "user" and n.subject_id == member.id and n.work_id is None
        for n in notices
    )
    client = world.client(member)
    assert client.get("/api/notifications/unread-count").json() == {"unread_count": 2}
    items = client.get("/api/notifications?status=unread").json()["items"]
    assert len(items) == 2 and all(i["scheduled_for"] is None for i in items)
    assert client.post("/api/notifications/read-all").json() == {"updated_count": 2}
    assert client.post(f"/api/notifications/{notices[0].id}/read").status_code == 200
    assert (
        world.client(world.admin).post(f"/api/notifications/{notices[0].id}/read").status_code
        == 404
    )


def test_grants_compare_department_and_module_authority_with_guest_caps(world):
    member = world.colleague
    module = add_module(world.db, world.inventory)
    guest = add_user(world.db, role=UserRole.GUEST)
    pending = add_user(world.db, status=UserStatus.PENDING)
    world.db.add_all([GroupMember(group_id=world.group.id, user_id=u.id) for u in (guest, pending)])
    world.db.commit()
    dep = str(world.inventory.id)
    _access(
        world,
        world.group,
        [
            {"department_id": dep, "level": "manage"},
            {"department_id": dep, "module_id": str(module.id), "level": "read"},
        ],
    )
    assert len(_notices(world, member)) == 1  # department changed while module stayed read
    assert _notices(world, guest) == [] and _notices(world, pending) == []
    _access(
        world,
        world.group,
        [
            {"department_id": dep, "level": "manage"},
            {"department_id": dep, "module_id": str(module.id), "level": "read"},
        ],
    )
    assert len(_notices(world, member)) == 1
    _access(world, world.group, [])
    assert len(_notices(world, member)) == 2 and len(_notices(world, guest)) == 1
    assert _notices(world, pending) == []


@pytest.mark.parametrize(
    ("initial", "payload", "expected"),
    [
        ("active", {"role": "admin"}, 1),
        ("active", {"role": "member"}, 0),
        ("disabled", {"role": "admin", "status": "active"}, 1),
        ("disabled", {"status": "active"}, 0),
        ("active", {"status": "disabled", "role": "admin"}, 0),
        ("pending", {"role": "admin"}, 0),
        ("active", {"display_name": "A changed display name"}, 0),
        ("active", {"expires_at": "2027-10-06T12:00:00Z"}, 0),
    ],
)
def test_role_combined_activation_and_non_authority_edits(world, initial, payload, expected):
    target = world.member
    target.status = initial
    world.db.commit()
    response = world.client(world.admin).patch(f"/api/users/{target.id}", json=payload)
    assert response.status_code == 200, response.text
    assert len(_notices(world, target)) == expected
    if (
        payload.get("role") == "admin"
        and payload.get("status") != "disabled"
        and initial != "pending"
    ):
        # A later demotion is a distinct authority delta even after membership cleanup.
        response = world.client(world.admin).patch(
            f"/api/users/{target.id}", json={"role": "member"}
        )
        assert response.status_code == 200, response.text
        assert len(_notices(world, target)) == expected + 1


def test_refused_and_failed_writes_leave_no_notices_or_partial_membership(world, monkeypatch):
    _members(world, world.group, [world.member], status=412, etag='"stale"')
    denied = world.client(world.member).put(
        f"/api/access/groups/{world.group.id}/access",
        json={"access": []},
        headers={"If-Match": f'"{world.group.id}:{world.group.revision}"'},
    )
    assert denied.status_code == 403
    _access(
        world,
        world.group,
        [
            {
                "department_id": str(world.finance.id),
                "module_id": str(world.finance_module.id),
                "level": "read",
            },
            {
                "department_id": str(world.inventory.id),
                "module_id": str(world.finance_module.id),
                "level": "read",
            },
        ],
        status=409,
    )
    from sqlalchemy.exc import SQLAlchemyError

    def reject():
        world.db.flush()
        raise SQLAlchemyError("controlled access commit failure")

    monkeypatch.setattr(world.db, "commit", reject)
    _members(world, world.group, [world.colleague, world.member], status=503)
    assert _notices(world, world.member) == []
    assert list(
        world.db.scalars(select(GroupMember.user_id).where(GroupMember.group_id == world.group.id))
    ) == [world.colleague.id]
