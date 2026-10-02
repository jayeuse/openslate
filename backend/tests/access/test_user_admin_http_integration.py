"""Access administration actions over HTTP against PostgreSQL.

These are the user and group writes the Access screens call: role changes,
disable and enable, delete and restore, and group edits under an ETag. Each
test goes through the real routes and the real administrator checks.
"""

from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.account_operations as account_operations
from app.common.dependencies.auth import CurrentIdentity, get_current_identity, get_current_user
from app.core.database import get_db
from app.systems.access.identity.models import IdentitySession
from app.systems.access.policy.configuration_router import router as access_policy_router
from app.systems.access.policy.models import AccessLevel, Group, GroupAccess
from app.systems.access.users.account_operations import router as account_operations_router
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.access.users.sessions_router import auth_router as collection_sessions_router
from app.systems.access.users.sessions_router import router as admin_sessions_router
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditLog, SecurityEventOutcome
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from tests.rbac.support import add_department, add_module, add_user, make_group_access

pytestmark = pytest.mark.integration


@dataclass
class _World:
    db: Session
    admin: User
    member: User
    colleague: User
    inventory: Department
    finance: Department
    finance_module: Module
    group: Group
    actor: list[User]
    events: list[tuple[str, SecurityEventOutcome, UUID]]
    # (event_type, operation_id, actor_id) for each captured outcome, in order.
    operations: list[tuple[str, UUID, UUID]]
    _client: TestClient
    sessions: dict[UUID, IdentitySession] = field(default_factory=dict)

    def client(self, user: User) -> TestClient:
        self.actor[:] = [user]
        set_audit_actor(self.db, user.id)
        return self._client

    def access_rows(self, group: Group) -> set[tuple[str, str | None, str]]:
        rows = self.db.scalars(select(GroupAccess).where(GroupAccess.group_id == group.id)).all()
        return {
            (
                str(row.department_id),
                None if row.module_id is None else str(row.module_id),
                str(row.level),
            )
            for row in rows
        }


def _add_session(db: Session, user: User) -> IdentitySession:
    session = IdentitySession(
        user_id=user.id,
        refresh_token_digest=uuid7().hex * 2,
        csrf_token_digest=uuid7().hex * 2,
        expires_at=datetime.now(UTC) + timedelta(days=7),
    )
    db.add(session)
    db.flush()
    return session


def _etag(group: Group) -> str:
    return f'"{group.id}:{group.revision}"'


@pytest.fixture
def world(integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch) -> Iterator[_World]:
    db = integration_owner_db
    # Security events commit through a second connection that cannot see these
    # uncommitted users; capture the outcomes instead.
    events: list[tuple[str, SecurityEventOutcome, UUID]] = []
    operations: list[tuple[str, UUID, UUID]] = []

    def capture_outcome(
        event_type: str,
        outcome: SecurityEventOutcome,
        operation_id: UUID,
        actor_id: UUID,
        target_id: UUID,
        reason: str | None = None,
    ) -> None:
        events.append((event_type, outcome, target_id))
        operations.append((event_type, operation_id, actor_id))

    monkeypatch.setattr(account_operations, "_record_outcome", capture_outcome)

    inventory = add_department(db)
    finance = add_department(db)
    finance_module = add_module(db, finance)
    admin = add_user(db, "user-admin-http-admin", role=UserRole.ADMIN)
    member = add_user(db, "user-admin-http-member")
    colleague = add_user(db, "user-admin-http-colleague")
    grant = make_group_access(db, [colleague], inventory, level=AccessLevel.READ)
    group = db.get(Group, grant.group_id)
    assert group is not None
    sessions = {user.id: _add_session(db, user) for user in (admin, member)}
    # Release the setup savepoint so a refused request rolls back only its own work.
    db.commit()

    actor: list[User] = []
    app = FastAPI()
    app.include_router(account_operations_router, prefix="/api")
    app.include_router(admin_sessions_router, prefix="/api")
    app.include_router(collection_sessions_router, prefix="/api")
    app.include_router(access_policy_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor[0]
    app.dependency_overrides[get_current_identity] = lambda: CurrentIdentity(
        actor[0], uuid7(), False, False
    )
    with TestClient(app) as client:
        yield _World(
            db=db,
            admin=admin,
            member=member,
            colleague=colleague,
            inventory=inventory,
            finance=finance,
            finance_module=finance_module,
            group=group,
            actor=actor,
            events=events,
            operations=operations,
            _client=client,
            sessions=sessions,
        )


def _user_role_audit(db: Session, user: User) -> list[AuditLog]:
    rows = db.scalars(
        select(AuditLog)
        .where(
            AuditLog.entity_type == "users",
            AuditLog.entity_id == user.id,
            AuditLog.action == "update",
        )
        .order_by(AuditLog.created_at, AuditLog.id)
    ).all()
    return [row for row in rows if row.after is not None and "role" in row.after]


def _one_operation_by(world: _World, actor: User) -> None:
    """Every captured outcome belongs to one operation performed by `actor`."""
    assert world.operations, "no security event was recorded"
    assert len({operation_id for _, operation_id, _ in world.operations}) == 1
    assert {actor_id for _, _, actor_id in world.operations} == {actor.id}


def _clear_events(world: _World) -> None:
    world.events.clear()
    world.operations.clear()


def test_administrator_promotes_and_demotes_a_member_with_an_audit_record(
    world: _World,
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
    assert world.member.role == UserRole.MEMBER.value
    audited = _user_role_audit(world.db, world.member)
    assert [(row.before or {}).get("role") for row in audited] == ["member", "admin"]
    assert [(row.after or {}).get("role") for row in audited] == ["admin", "member"]
    assert {row.performed_by for row in audited} == {world.admin.id}


def test_disabling_a_member_revokes_their_sessions_and_enabling_restores_the_account(
    world: _World,
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


def test_administrator_deletes_and_restores_a_member_once(world: _World) -> None:
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


def test_member_is_refused_every_user_administration_route(world: _World) -> None:
    client = world.client(world.member)
    target = world.colleague
    target_session = _add_session(world.db, target)
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
    assert (target.role, target.status, target.is_deleted) == (
        UserRole.MEMBER.value,
        UserStatus.ACTIVE.value,
        False,
    )
    assert target_session.revoked_at is None
    assert world.events == []


def test_administrator_gets_not_found_for_an_unknown_user(world: _World) -> None:
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


def test_group_rename_requires_the_current_version(world: _World) -> None:
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


def test_administrator_replaces_group_access_and_the_revision_advances(world: _World) -> None:
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


def test_non_administrator_cannot_replace_group_access(world: _World) -> None:
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
