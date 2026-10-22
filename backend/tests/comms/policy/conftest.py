"""Policy fixtures reuse Comms' guarded, committed two-organization world.

Ordinary policy cases roll back; only foreign-reference setup commits owned rows.
"""

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from uuid import UUID

import pytest
from sqlalchemy import select
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.access.policy.models import Group, GroupMember
from app.systems.access.users.models import User
from app.systems.boards.models import Board
from app.systems.comms.conversations.models import (
    CommsCategory,
    CommsConversation,
    CommsMember,
)
from app.systems.comms.settings.models import (
    CommsCapabilityGrant,
    CommsSettingLock,
    CommsSettings,
)
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.conftest import create_member

if TYPE_CHECKING:
    from tests.comms.conftest import CommsOrganization, CommsWorld

PAST = datetime(2000, 1, 1, tzinfo=UTC)
FUTURE = datetime(2100, 1, 1, tzinfo=UTC)


@dataclass
class PolicyCase:
    db: AuditSession
    world: "CommsWorld"
    org: "CommsOrganization"
    admin: User
    actor: User
    peer: User
    category: CommsCategory
    department: Department

    def person(self, name: str, *, role: str = "member", **values) -> User:
        organization = self.db.get(WorkspaceProfile, self.org.id)
        assert organization is not None
        if role == "guest":
            values = {"sponsor_user_id": self.admin.id, "expires_at": FUTURE, **values}
        person, _ = create_member(
            self.db, organization, role=role, display_name=name, **values,
        )
        return person

    def conversation(
        self, *, scope=None, kind="channel", category=None, department=None, creator=None,
    ) -> CommsConversation:
        # D44: a channel defaults to the fixture department; direct and group use members.
        scope = scope or ("department" if kind == "channel" else "members")
        if scope == "department":
            department = department or self.department
        row = CommsConversation(
            org_id=self.org.id, kind=kind, scope=scope, name="Policy candidate",
            category_id=category.id if category else None,
            department_id=department.id if department else None,
            created_by=(creator or self.admin).id,
        )
        self.db.add(row)
        self.db.flush()
        return row

    def member(self, conversation, person, *, role="member") -> CommsMember:
        row = CommsMember(
            org_id=self.org.id, conversation_id=conversation.id, user_id=person.id, role=role,
        )
        self.db.add(row)
        self.db.flush()
        return row

    def group(self, *people, name="Policy group") -> Group:
        row = Group(org_id=self.org.id, name=f"{name} {uuid7().hex}")
        self.db.add(row)
        self.db.flush()
        self.db.add_all([
            GroupMember(org_id=self.org.id, group_id=row.id, user_id=person.id)
            for person in people
        ])
        self.db.flush()
        return row

    def other_department(self, name: str = "Other policy department") -> Department:
        row = Department(org_id=self.org.id, department_name=f"{name} {uuid7().hex}")
        self.db.add(row)
        self.db.flush()
        return row

    def settings(self, scope: dict, values: dict) -> CommsSettings:
        row = CommsSettings(org_id=self.org.id, values=values, **scope_columns(scope))
        self.db.add(row)
        self.db.flush()
        return row

    def grant(self, scope: dict, capability: str, *, group=None, granted=True):
        row = CommsCapabilityGrant(
            org_id=self.org.id, capability=capability,
            subject="group" if group else "everyone",
            group_id=group.id if group else None, granted=granted, **scope_columns(scope),
        )
        self.db.add(row)
        self.db.flush()
        return row

    def lock(self, namespace: str, key: str) -> CommsSettingLock:
        row = CommsSettingLock(org_id=self.org.id, namespace=namespace, key=key)
        self.db.add(row)
        self.db.flush()
        return row


def scope_columns(scope: dict) -> dict:
    """Fixture storage shape only; no resolution, admission, or authority calculation."""
    return {
        "scope": scope["kind"],
        "category_id": scope.get("id") if scope["kind"] == "category" else None,
        "conversation_id": scope.get("id") if scope["kind"] == "channel" else None,
    }


@pytest.fixture
def policy_case(comms_world) -> Iterator[PolicyCase]:
    org = comms_world.first
    with comms_world.session(org) as db:
        admin = db.get(User, org.author)
        peer = db.get(User, org.peer)
        category = db.get(CommsCategory, org.category)
        department = db.get(Department, org.department)
        assert admin is not None and peer is not None
        assert category is not None and department is not None
        # Do not let the persistence world's organization channels mask a D36 denial.
        for row in db.scalars(select(CommsConversation).where(
            CommsConversation.org_id == org.id,
        )):
            row.is_deleted, row.deleted_at = True, PAST
        # Only this run-owned organization, never a shared/default installation Board.
        for row in db.scalars(select(Board).where(Board.org_id == org.id)):
            row.is_deleted, row.deleted_at = True, PAST
        db.flush()
        case = PolicyCase(db, comms_world, org, admin, peer, peer, category, department)
        case.actor = case.person("Actor")
        try:
            yield case
        finally:
            # Includes additional users/memberships, groups, access, audit and policy rows.
            # No test using this fixture may commit; committed race uses comms_world only.
            db.rollback()


@pytest.fixture
def foreign_references(comms_world) -> Iterator[dict[str, UUID]]:
    """Real, committed foreign IDs; a missing random UUID would not prove isolation."""
    org = comms_world.second
    identities = {}
    try:
        with comms_world.session(org) as db:
            module = Module(org_id=org.id, department_id=org.department, module_name="Foreign")
            db.add(module)
            db.flush()
            identities["module"] = module.id
            field = Field(
                org_id=org.id, module_id=module.id, name="Foreign", type="text", position=0,
            )
            record = Record(org_id=org.id, module_id=module.id, data={})
            db.add_all([field, record])
            db.flush()
            identities.update(field=field.id, record=record.id)
            db.commit()
        yield identities
    finally:
        # CommsWorld.clean does not own fields; remove only these tracked fixture IDs first.
        with comms_world.session(org) as db:
            for kind, model in (("field", Field), ("record", Record), ("module", Module)):
                identity = identities.get(kind)
                if identity is not None:
                    row = db.get(model, identity)
                    if row is not None:
                        db.delete(row)
                        db.flush()
            db.commit()
