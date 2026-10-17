"""Owned export journeys through signed Auth, policy, runtime role and PostgreSQL.

The reader signs in through the real login route against the fake provider: these tests
check export authorization and output, not Supabase Auth.
"""

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.policy.models import AccessLevel, Group, GroupAccess, GroupMember
from app.systems.access.users.models import User
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.openview.views.models import SavedView
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.conftest import membership_of
from tests.fake_provider_support import fake_provider as fake_provider
from tests.fake_provider_support import fake_provider_account as fake_provider_account
from tests.rbac.support import add_department, add_module, add_user, make_group_access


@dataclass
class ExportWorld:
    owner: Engine
    actor_id: UUID
    session_id: UUID
    module_id: UUID
    department_id: UUID
    label_id: UUID
    amount_id: UUID
    grant_id: UUID
    group_id: UUID
    view_id: UUID
    record_ids: list[UUID]
    client: TestClient
    sponsor_id: UUID | None = None

    def payload(self, **options: Any) -> dict[str, Any]:
        return {
            "module_id": str(self.module_id),
            "definition": {
                "columns": [
                    {"field_id": str(self.label_id), "expected_type": "text"},
                    {"field_id": str(self.amount_id), "expected_type": "decimal"},
                ],
                "filters": [
                    {
                        "field_id": str(self.amount_id),
                        "expected_type": "decimal",
                        "operator": "gt",
                        "value": "2",
                    }
                ],
                "sort": [
                    {
                        "field_id": str(self.amount_id),
                        "expected_type": "decimal",
                        "direction": "asc",
                    }
                ],
            },
            **options,
        }

    def role(self, role: str) -> None:
        with Session(self.owner) as db:
            actor = membership_of(db, self.actor_id)
            assert actor is not None
            if role == "guest":
                db.info["rbac_organization"] = db.get(WorkspaceProfile, actor.org_id)
                sponsor = add_user(db)
                self.sponsor_id = sponsor.id
                actor.sponsor_user_id = sponsor.id
                actor.expires_at = datetime.now(UTC) + timedelta(days=1)
            actor.role = role
            db.commit()

    def events(self) -> list[SecurityEvent]:
        with Session(self.owner) as db:
            return list(
                db.scalars(
                    select(SecurityEvent).where(
                        SecurityEvent.actor_id == self.actor_id,
                        SecurityEvent.event_type == "records.export.authorized",
                    )
                )
            )


@pytest.fixture
def export_world(fake_provider_account) -> Iterator[ExportWorld]:
    email, password, provider_id, actor_id, owner = fake_provider_account
    with Session(owner) as db:
        actor = db.get(User, actor_id)
        assert actor is not None
        db.info["rbac_organization"] = db.get(
            WorkspaceProfile, membership_of(db, actor_id).org_id
        )
        actor.supabase_user_id = provider_id
        actor.display_name = "Export reader"
        department = add_department(db)
        module = add_module(db, department, "Sales / ledger")
        label = Field(org_id=module.org_id, module_id=module.id,
                      name="Label", type="text", position=0, config={})
        amount = Field(org_id=module.org_id, module_id=module.id,
                       name="Amount", type="decimal", position=1, config={})
        db.add_all([label, amount])
        db.flush()
        records = [
            Record(org_id=module.org_id, module_id=module.id,
                   data={str(label.id): name, str(amount.id): value})
            for name, value in (("Alpha", "2"), ("Beta", "10"), ("Gamma", "3"))
        ]
        db.add_all(records)
        grant = make_group_access(db, [actor], department, module, level=AccessLevel.READ)
        view = SavedView(
            org_id=module.org_id,
            module_id=module.id,
            name="Reviewed records",
            definition={"version": 1, "columns": []},
        )
        db.add(view)
        db.commit()
        module_id, department_id = module.id, department.id
        label_id, amount_id = label.id, amount.id
        grant_id, group_id, view_id = grant.id, grant.group_id, view.id
        record_ids = [record.id for record in records]

    settings = get_settings()
    client = TestClient(
        create_app(), base_url=settings.public_origin, raise_server_exceptions=False
    )
    client.headers["Origin"] = settings.public_origin
    world = None
    try:
        login = client.post("/api/auth/login", json={"email": email, "password": password})
        assert login.status_code == 200
        client.headers["X-CSRF-Token"] = client.cookies["openslate_csrf"]
        with Session(owner) as db:
            session_id = db.scalar(
                select(IdentitySession.id).where(IdentitySession.user_id == actor_id)
            )
            assert session_id is not None
        world = ExportWorld(
            owner,
            actor_id,
            session_id,
            module_id,
            department_id,
            label_id,
            amount_id,
            grant_id,
            group_id,
            view_id,
            record_ids,
            client,
        )
        yield world
    finally:
        client.close()
        with owner.begin() as connection:
            # This fixture owns committed rows on the runner's disposable target only.
            connection.execute(
                text("DELETE FROM public.saved_views WHERE id = :id"), {"id": view_id}
            )
            for model in (SavedView, Record, Field):
                connection.execute(
                    text(f"DELETE FROM public.{model.__tablename__} WHERE module_id = :id"),
                    {"id": module_id},
                )
            for model in (GroupMember, GroupAccess):
                connection.execute(
                    text(f"DELETE FROM public.{model.__tablename__} WHERE group_id = :id"),
                    {"id": group_id},
                )
            for model, identifier in (
                (Group, group_id),
                (Module, module_id),
                (Department, department_id),
            ):
                connection.execute(
                    text(f"DELETE FROM public.{model.__tablename__} WHERE id = :id"),
                    {"id": identifier},
                )
            connection.execute(
                text("DELETE FROM public.security_events WHERE actor_id = :id"), {"id": actor_id}
            )
        if world is not None and world.sponsor_id is not None:
            with Session(owner) as db:
                actor = membership_of(db, actor_id)
                actor.role, actor.sponsor_user_id, actor.expires_at = "member", None, None
                db.flush()
                db.delete(membership_of(db, world.sponsor_id))
                db.flush()
                db.delete(db.get(User, world.sponsor_id))
                db.commit()
