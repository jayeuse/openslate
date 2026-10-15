"""A manager, members, guests and groups behind the real Access group router."""

from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.policy.configuration_router import router as access_policy_router
from app.systems.access.policy.models import AccessLevel, Group, GroupMember
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.manage.audit.context import set_audit_actor
from app.systems.sandbox.departments.models import Department
from tests.rbac.support import add_department, add_module, add_user, make_group_access, organization


@dataclass
class DelegationWorld:
    db: Session
    inventory: Department
    finance: Department
    admin: User
    manager: User
    guest_manager: User
    plain: User
    guest: User
    pending: User
    other_admin: User
    inventory_group: Group
    module_group: Group
    manager_group: Group
    mixed_group: Group
    empty_group: Group
    actor: list[User]
    _client: TestClient

    def client(self, user: User) -> TestClient:
        self.actor[:] = [user]
        set_audit_actor(self.db, user.id)
        return self._client

    def members(self, group: Group) -> set:
        return set(
            self.db.scalars(
                select(GroupMember.user_id).where(GroupMember.group_id == group.id)
            ).all()
        )


def add_group(db: Session, name: str) -> Group:
    group = Group(org_id=organization(db).id, name=f"{name} {uuid7().hex}")
    db.add(group)
    db.flush()
    return group


@pytest.fixture
def world(integration_owner_db: Session) -> Iterator[DelegationWorld]:
    db = integration_owner_db
    inventory = add_department(db)
    finance = add_department(db)
    inventory_module = add_module(db, inventory)
    admin = add_user(db, "delegation-admin", role=UserRole.ADMIN)
    manager = add_user(db, "delegation-manager")
    guest_manager = add_user(db, "delegation-guest-manager", role=UserRole.GUEST)
    plain = add_user(db, "delegation-plain")
    guest = add_user(db, "delegation-guest", role=UserRole.GUEST)
    pending = add_user(db, "delegation-pending", status=UserStatus.PENDING)
    other_admin = add_user(db, "delegation-other-admin", role=UserRole.ADMIN)

    manager_group = make_group_access(
        db, [manager, guest_manager], inventory, level=AccessLevel.MANAGE
    ).group_id
    inventory_group = make_group_access(db, [plain], inventory, level=AccessLevel.READ).group_id
    module_group = make_group_access(
        db, [plain], inventory, inventory_module, level=AccessLevel.WRITE
    ).group_id
    mixed = make_group_access(db, [plain], inventory, level=AccessLevel.WRITE)
    make_group_access(db, [], finance, level=AccessLevel.READ, group=db.get(Group, mixed.group_id))
    empty_group = add_group(db, "No access")
    db.add(GroupMember(org_id=empty_group.org_id, group_id=empty_group.id, user_id=plain.id))
    # Release the setup savepoint so a refused request rolls back only its own work.
    db.commit()

    actor: list[User] = []
    app = FastAPI()
    app.include_router(access_policy_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor[0]
    with TestClient(app) as client:
        yield DelegationWorld(
            db=db,
            inventory=inventory,
            finance=finance,
            admin=admin,
            manager=manager,
            guest_manager=guest_manager,
            plain=plain,
            guest=guest,
            pending=pending,
            other_admin=other_admin,
            inventory_group=db.get(Group, inventory_group),
            module_group=db.get(Group, module_group),
            manager_group=db.get(Group, manager_group),
            mixed_group=db.get(Group, mixed.group_id),
            empty_group=empty_group,
            actor=actor,
            _client=client,
        )
