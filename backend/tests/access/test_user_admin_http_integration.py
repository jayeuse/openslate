"""Access administration actions over HTTP against PostgreSQL.

These are the user and group writes the Access screens call: role changes,
disable and enable, delete and restore, and group edits under an ETag. Each
test goes through the real routes and the real administrator checks.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel, Group
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.manage.audit.models import AuditLog, SecurityEventOutcome
from tests.access.user_admin_support import UserAdminWorld, add_session
from tests.access.user_admin_support import world as world
from tests.conftest import create_member, make_operator, membership_of
from tests.rbac.support import organization

pytestmark = pytest.mark.integration


def _etag(group: Group) -> str:
    return f'"{group.id}:{group.revision}"'


def _user_role_audit(db: Session, user: User) -> list[AuditLog]:
    membership = membership_of(db, user.id)
    rows = db.scalars(
        select(AuditLog)
        .where(
            AuditLog.entity_type == "memberships",
            AuditLog.entity_id == membership.id,
            AuditLog.action == "update",
        )
        .order_by(AuditLog.created_at, AuditLog.id)
    ).all()
    return [row for row in rows if row.after is not None and "role" in row.after]


def _one_operation_by(world: UserAdminWorld, actor: User) -> None:
    """Every captured outcome belongs to one operation performed by `actor`."""
    assert world.operations, "no security event was recorded"
    assert len({operation_id for _, operation_id, _ in world.operations}) == 1
    assert {actor_id for _, _, actor_id in world.operations} == {actor.id}


def _clear_events(world: UserAdminWorld) -> None:
    world.events.clear()
    world.operations.clear()


def test_administrator_promotes_and_demotes_a_member_with_an_audit_record(
    world: UserAdminWorld,
) -> None:
    client = world.client(world.admin)

    promoted = client.patch(f"/api/users/{world.member.id}", json={"role": "admin"})
    demoted = client.patch(f"/api/users/{world.member.id}", json={"role": "member"})

    assert promoted.status_code == 200, promoted.text
    assert promoted.json()["role"] == "admin"
    assert promoted.json()["performed_by"] == str(world.admin.id)
    assert demoted.status_code == 200, demoted.text
    assert demoted.json()["role"] == "member"
    world.db.refresh(world.member)
    assert membership_of(world.db, world.member.id).role == UserRole.MEMBER.value
    audited = _user_role_audit(world.db, world.member)
    assert [(row.before or {}).get("role") for row in audited] == ["member", "admin"]
    assert [(row.after or {}).get("role") for row in audited] == ["admin", "member"]
    assert {row.performed_by for row in audited} == {world.admin.id}


def test_disabling_a_member_revokes_their_sessions_and_enabling_restores_the_account(
    world: UserAdminWorld,
) -> None:
    client = world.client(world.admin)
    member_session = world.sessions[world.member.id]

    disabled = client.patch(f"/api/users/{world.member.id}", json={"status": "disabled"})

    assert disabled.status_code == 200, disabled.text
    assert disabled.json()["status"] == "disabled"
    world.db.refresh(world.member)
    world.db.refresh(member_session)
    assert world.member.status == UserStatus.DISABLED.value
    assert world.member.tokens_valid_after is not None
    assert member_session.revoked_at is not None
    assert world.events == [
        ("user.authentication_disable", SecurityEventOutcome.ATTEMPT, world.member.id),
        ("user.authentication_disable", SecurityEventOutcome.SUCCESS, world.member.id),
    ]
    _one_operation_by(world, world.admin)

    _clear_events(world)
    enabled = client.patch(f"/api/users/{world.member.id}", json={"status": "active"})

    assert enabled.status_code == 200, enabled.text
    assert enabled.json()["status"] == "active"
    world.db.refresh(world.member)
    world.db.refresh(member_session)
    assert world.member.status == UserStatus.ACTIVE.value
    # Enabling the account does not bring back a revoked session.
    assert member_session.revoked_at is not None
    assert world.events == [
        ("user.authentication_activation", SecurityEventOutcome.ATTEMPT, world.member.id),
        ("user.authentication_activation", SecurityEventOutcome.SUCCESS, world.member.id),
    ]
    _one_operation_by(world, world.admin)


def test_administrator_deletes_and_restores_a_member_once(world: UserAdminWorld) -> None:
    make_operator(world.db, world.admin)
    world.db.commit()
    client = world.client(world.admin)
    member_session = world.sessions[world.member.id]

    deleted = client.delete(f"/api/users/{world.member.id}")

    assert deleted.status_code == 204, deleted.text
    assert deleted.content == b""
    world.db.refresh(world.member)
    world.db.refresh(member_session)
    assert world.member.is_deleted is True
    assert world.member.status == UserStatus.DISABLED.value
    assert member_session.revoked_at is not None
    assert world.events == [
        ("user.authentication_disable", SecurityEventOutcome.ATTEMPT, world.member.id),
        ("user.authentication_disable", SecurityEventOutcome.SUCCESS, world.member.id),
    ]
    _one_operation_by(world, world.admin)

    deleted_again = client.delete(f"/api/users/{world.member.id}")

    assert deleted_again.status_code == 409
    assert deleted_again.json() == {"detail": "User is already deleted"}

    _clear_events(world)
    restored = client.post(f"/api/users/{world.member.id}/restore")

    assert restored.status_code == 200, restored.text
    assert restored.json()["status"] == "active"
    assert restored.json()["is_deleted"] is False
    assert restored.json()["deleted_at"] is None
    world.db.refresh(world.member)
    assert world.member.is_deleted is False
    assert world.member.status == UserStatus.ACTIVE.value
    assert world.events == [
        ("user.authentication_restore", SecurityEventOutcome.ATTEMPT, world.member.id),
        ("user.authentication_restore", SecurityEventOutcome.SUCCESS, world.member.id),
    ]
    _one_operation_by(world, world.admin)

    restored_again = client.post(f"/api/users/{world.member.id}/restore")

    assert restored_again.status_code == 409
    assert restored_again.json() == {"detail": "User is not deleted"}


def test_member_is_refused_every_user_administration_route(world: UserAdminWorld) -> None:
    client = world.client(world.member)
    target = world.colleague
    target_session = add_session(world.db, target)
    world.db.commit()

    responses = {
        "patch": client.patch(f"/api/users/{target.id}", json={"status": "disabled"}),
        "delete": client.delete(f"/api/users/{target.id}"),
        "restore": client.post(f"/api/users/{target.id}/restore"),
        "sessions": client.delete(f"/api/users/{target.id}/sessions"),
    }

    assert {name: response.status_code for name, response in responses.items()} == {
        "patch": 403,
        "delete": 403,
        "restore": 403,
        "sessions": 403,
    }
    assert {name: response.json() for name, response in responses.items()} == {
        name: {"detail": "Forbidden"} for name in responses
    }
    world.db.refresh(target)
    world.db.refresh(target_session)
    assert (membership_of(world.db, target.id).role, target.status, target.is_deleted) == (
        UserRole.MEMBER.value,
        UserStatus.ACTIVE.value,
        False,
    )
    assert target_session.revoked_at is None
    assert world.events == []


def test_administrator_gets_not_found_for_an_unknown_user(world: UserAdminWorld) -> None:
    client = world.client(world.admin)
    unknown = uuid7()

    responses: dict[str, Any] = {
        "patch": client.patch(f"/api/users/{unknown}", json={"job_title": "Clerk"}),
        "delete": client.delete(f"/api/users/{unknown}"),
        "restore": client.post(f"/api/users/{unknown}/restore"),
        "sessions": client.delete(f"/api/users/{unknown}/sessions"),
    }

    assert {name: response.status_code for name, response in responses.items()} == {
        name: 404 for name in responses
    }
    assert {name: response.json() for name, response in responses.items()} == {
        name: {"detail": "User not found"} for name in responses
    }


def _make_world_admin_the_only_usable_one(world: UserAdminWorld) -> None:
    """Disable, inside this test's transaction, administrators that other tests committed."""
    others = world.db.scalars(
        select(User).join(Membership, Membership.user_id == User.id).where(
            Membership.role == UserRole.ADMIN.value,
            User.status == UserStatus.ACTIVE.value,
            User.id != world.admin.id,
        )
    ).all()
    for other in others:
        other.status = UserStatus.DISABLED.value
    world.db.flush()


def _add_admin(world: UserAdminWorld, name: str, **state: Any) -> User:
    admin, _membership = create_member(
        world.db, organization(world.db),
        email=f"{name}-{uuid7().hex}@example.com",
        username=f"{name}-{uuid7().hex[-12:]}",
        role=UserRole.ADMIN.value,
        status=UserStatus.ACTIVE.value,
        **state,
    )
    return admin


def test_unusable_administrators_do_not_keep_the_last_usable_one(world: UserAdminWorld) -> None:
    _make_world_admin_the_only_usable_one(world)
    past = datetime.now(UTC) - timedelta(days=1)
    # Deleted, never-accepted and expired administrators can no longer act.
    _add_admin(world, "deleted-admin", is_deleted=True, deleted_at=past)
    _add_admin(world, "unaccepted-admin", invitation_sent_at=past)
    _add_admin(world, "expired-admin", expires_at=past)
    world.db.commit()
    client = world.client(world.admin)

    demoted = client.patch(f"/api/users/{world.admin.id}", json={"role": "member"})

    assert demoted.status_code == 409
    assert demoted.json() == {"detail": "Cannot remove the last active admin"}
    world.db.refresh(world.admin)
    assert membership_of(world.db, world.admin.id).role == UserRole.ADMIN.value


def test_a_temporary_administrator_does_not_keep_the_last_durable_one(
    world: UserAdminWorld,
) -> None:
    _make_world_admin_the_only_usable_one(world)
    temporary = _add_admin(
        world, "temporary-admin", expires_at=datetime.now(UTC) + timedelta(days=30)
    )
    world.db.commit()
    client = world.client(world.admin)

    durable_demoted = client.patch(f"/api/users/{world.admin.id}", json={"role": "member"})
    temporary_demoted = client.patch(f"/api/users/{temporary.id}", json={"role": "member"})

    assert durable_demoted.status_code == 409
    assert durable_demoted.json() == {"detail": "Cannot remove the last durable admin"}
    # The durable administrator remains, so the temporary one may step down.
    assert temporary_demoted.status_code == 200, temporary_demoted.text
    assert temporary_demoted.json()["role"] == "member"


def test_group_rename_requires_the_current_version(world: UserAdminWorld) -> None:
    group = world.group
    revision = group.revision
    client = world.client(world.admin)
    new_name = f"Renamed {uuid7().hex}"

    missing = client.patch(f"/api/access/groups/{group.id}", json={"name": new_name})
    stale = client.patch(
        f"/api/access/groups/{group.id}",
        json={"name": new_name},
        headers={"If-Match": f'"{group.id}:{revision + 99}"'},
    )

    assert (missing.status_code, missing.json()) == (428, {"detail": "If-Match is required"})
    assert (stale.status_code, stale.json()) == (412, {"detail": "Resource changed"})
    world.db.refresh(group)
    assert group.revision == revision
    assert group.name != new_name

    renamed = client.patch(
        f"/api/access/groups/{group.id}",
        json={"name": new_name},
        headers={"If-Match": f'"{group.id}:{revision}"'},
    )

    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == new_name
    assert renamed.json()["revision"] == revision + 1
    assert renamed.headers["ETag"] == f'"{group.id}:{revision + 1}"'
    world.db.refresh(group)
    assert (group.name, group.revision, group.performed_by) == (
        new_name,
        revision + 1,
        world.admin.id,
    )


def test_administrator_replaces_group_access_and_the_revision_advances(
    world: UserAdminWorld,
) -> None:
    group = world.group
    revision = group.revision
    desired = {
        (str(world.inventory.id), None, AccessLevel.WRITE.value),
        (str(world.finance.id), str(world.finance_module.id), AccessLevel.READ.value),
    }

    response = world.client(world.admin).put(
        f"/api/access/groups/{group.id}/access",
        json={
            "access": [
                {"department_id": department_id, "module_id": module_id, "level": level}
                for department_id, module_id, level in desired
            ]
        },
        headers={"If-Match": _etag(group)},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["revision"] == revision + 1
    assert response.headers["ETag"] == f'"{group.id}:{revision + 1}"'
    assert {
        (item["department_id"], item["module_id"], item["level"]) for item in body["access"]
    } == desired
    assert world.access_rows(group) == desired
    world.db.refresh(group)
    assert (group.revision, group.performed_by) == (revision + 1, world.admin.id)


def test_non_administrator_cannot_replace_group_access(world: UserAdminWorld) -> None:
    group = world.group
    revision = group.revision
    before = world.access_rows(group)

    response = world.client(world.member).put(
        f"/api/access/groups/{group.id}/access",
        json={"access": [{"department_id": str(world.finance.id), "level": "manage"}]},
        headers={"If-Match": _etag(group)},
    )

    assert (response.status_code, response.json()) == (403, {"detail": "Forbidden"})
    world.db.refresh(group)
    assert group.revision == revision
    assert world.access_rows(group) == before
