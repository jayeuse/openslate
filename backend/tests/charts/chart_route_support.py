"""Concrete guarded Chart route fixtures; auth transport is unchanged and overridden."""

from dataclasses import dataclass
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.identity.models import IdentitySession
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from tests.live_session_support import with_live_session
from tests.rbac.support import _client, add_department, add_module, add_user, make_group_access
from tests.route_app_support import route_app


@dataclass
class ChartWorld:
    db: Session
    module: Module
    other_module: Module
    label: Field
    amount: Field
    date: Field
    person: Field
    users: dict[str, User]

    def client(self, key: str, *, session: IdentitySession | None = None) -> TestClient:
        """The complete application, without its process lifespan, as *key*."""

        actor = self.users[key]
        client = with_live_session(
            _client(route_app(), actor, self.db), self.db, actor, session=session
        )
        set_audit_actor(self.db, actor.id)
        return client

    def body(self, name: str = "Reviewed Chart", *, kind: str = "bar", query=None):
        return {
            "module_id": str(self.module.id),
            "name": name,
            "chart_type": kind,
            "query": query if query is not None else self.grouped(),
        }

    def grouped(self):
        return {
            "module_id": str(self.module.id),
            "definition": {"version": 1, "columns": [], "filters": []},
            "mode": "groups",
            "dimension": {"field_id": str(self.label.id), "expected_type": "text"},
            "aggregation": "count",
        }

    def audit_rows(self, chart_id: UUID) -> list[AuditLog]:
        self.db.expire_all()
        return list(
            self.db.scalars(
                select(AuditLog).where(
                    AuditLog.entity_type == "charts", AuditLog.entity_id == chart_id
                )
            ).all()
        )


@pytest.fixture
def chart_world(integration_owner_db: Session) -> ChartWorld:
    db = integration_owner_db
    department = add_department(db, "Chart source " + uuid7().hex)
    other_department = add_department(db, "Other source " + uuid7().hex)
    module = add_module(db, department)
    other_module = add_module(db, other_department)
    fields = [
        Field(org_id=module.org_id, module_id=module.id,
              name=name, type=kind, position=position, config={})
        for position, (name, kind) in enumerate(
            [
                ("Label", FieldType.TEXT),
                ("Amount", FieldType.NUMBER),
                ("Date", FieldType.DATE),
                ("Person", FieldType.USER),
            ]
        )
    ]
    db.add_all(fields)
    users = {
        key: add_user(db, "chart-" + key, role=role)
        for key, role in (
            ("admin", "admin"),
            ("manager", "member"),
            ("module_manager", "member"),
            ("reader", "member"),
            ("guest", "guest"),
            ("stranger", "member"),
        )
    }
    for key, level, scope in (
        ("manager", AccessLevel.MANAGE, None),
        ("module_manager", AccessLevel.MANAGE, module),
        ("reader", AccessLevel.READ, module),
        ("guest", AccessLevel.MANAGE, None),
    ):
        make_group_access(db, [users[key]], department, scope, level=level)
    db.flush()
    return ChartWorld(db, module, other_module, *fields, users)
