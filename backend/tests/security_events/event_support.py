"""Owned signed-auth/runtime PostgreSQL setup; event rows remain append-only until teardown.

The actor signs in through the real login route against the fake provider: these tests
check OpenSlate's security events, not Supabase Auth.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database.session import AuditSession, get_engine
from app.main import create_app
from app.systems.access.users.models import User
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.auth.session_policy_support import DEFAULTS, POLICY_FIELDS
from tests.fake_provider_support import fake_provider as fake_provider
from tests.fake_provider_support import fake_provider_account as fake_provider_account


@dataclass
class EventWorld:
    client: TestClient = field(repr=False)
    owner: object = field(repr=False)
    actor_id: UUID
    provider_id: UUID
    email: str = field(repr=False)
    password: str = field(repr=False)
    operation_id: UUID = field(default_factory=uuid4)
    clock: datetime = field(default_factory=lambda: datetime.now(UTC))

    def policy(self, **values):
        with Session(self.owner) as db:
            profile = db.scalar(select(WorkspaceProfile))
            for name, value in values.items():
                setattr(profile, name, value)
            db.commit()

    def records(self, event_type=None, *, operation_id=None, actor_id=None):
        statement = select(SecurityEvent)
        if event_type is not None:
            statement = statement.where(SecurityEvent.event_type == event_type)
        if operation_id is not None:
            statement = statement.where(SecurityEvent.operation_id == operation_id)
        if actor_id is not None:
            statement = statement.where(SecurityEvent.actor_id == actor_id)
        with Session(self.owner) as db:
            return list(db.scalars(statement.order_by(SecurityEvent.occurred_at, SecurityEvent.id)))

    def anonymous(self, address="192.0.2.120"):
        client = TestClient(
            self.client.app,
            base_url=get_settings().public_origin,
            client=(address, 50000) if address is not None else None,
            raise_server_exceptions=False,
        )
        client.headers["Origin"] = get_settings().public_origin
        return client


@pytest.fixture
def event_world(fake_provider_account):
    email, password, provider_id, actor_id, owner = fake_provider_account
    with Session(owner) as db:
        actor = db.get(User, actor_id)
        actor.supabase_user_id, actor.role = provider_id, "admin"
        profile = db.scalar(select(WorkspaceProfile))
        saved = {name: getattr(profile, name) for name in POLICY_FIELDS}
        for name, value in DEFAULTS.items():
            setattr(profile, name, value)
        db.commit()
    client = TestClient(
        create_app(),
        base_url=get_settings().public_origin,
        client=("127.0.0.1", 50000),
        raise_server_exceptions=False,
    )
    client.headers["Origin"] = get_settings().public_origin
    try:
        assert (
            client.post("/api/auth/login", json={"email": email, "password": password}).status_code
            == 200
        )
        csrf = client.cookies.get("openslate_csrf")
        assert csrf
        client.headers["X-CSRF-Token"] = csrf
        yield EventWorld(client, owner, actor_id, provider_id, email, password)
    finally:
        client.close()
        with Session(owner) as db:
            profile = db.scalar(select(WorkspaceProfile))
            for name, value in saved.items():
                setattr(profile, name, value)
            db.commit()


def append_committed(*, identity=None, **values):
    with AuditSession(bind=get_engine()) as db:
        row = append_security_event(db, SecurityEventIngestRequest(**values))
        if identity is not None:
            row.id = identity
        identity = row.id
        db.commit()
        return identity
