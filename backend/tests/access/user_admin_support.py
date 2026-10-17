"""An administrator, a member and a colleague behind the real user-administration routers."""

from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
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
from app.systems.access.users.models import User, UserRole
from app.systems.access.users.sessions_router import auth_router as collection_sessions_router
from app.systems.access.users.sessions_router import router as admin_sessions_router
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from tests.organization_scope_support import scoped_override
from tests.rbac.support import add_department, add_module, add_user, make_group_access


@dataclass
class UserAdminWorld:
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


def add_session(db: Session, user: User) -> IdentitySession:
    session = IdentitySession(
        user_id=user.id,
        refresh_token_digest=uuid7().hex * 2,
        csrf_token_digest=uuid7().hex * 2,
        expires_at=datetime.now(UTC) + timedelta(days=7),
    )
    db.add(session)
    db.flush()
    return session


@pytest.fixture
def world(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> Iterator[UserAdminWorld]:
    db = integration_owner_db
    # Security events commit through a second connection that cannot see these
    # uncommitted users; capture the outcomes instead.
    events: list[tuple[str, SecurityEventOutcome, UUID]] = []
    operations: list[tuple[str, UUID, UUID]] = []

    def capture_outcome(
        _db: Session,
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
    sessions = {user.id: add_session(db, user) for user in (admin, member)}
    # Release the setup savepoint so a refused request rolls back only its own work.
    db.commit()

    actor: list[User] = []
    app = FastAPI()
    app.include_router(account_operations_router, prefix="/api")
    app.include_router(admin_sessions_router, prefix="/api")
    app.include_router(collection_sessions_router, prefix="/api")
    app.include_router(access_policy_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = scoped_override(lambda: actor[0])
    app.dependency_overrides[get_current_identity] = scoped_override(lambda: CurrentIdentity(
        actor[0], uuid7(), False, False
    ))
    with TestClient(app) as client:
        yield UserAdminWorld(
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
