"""Shared audit isolation for local-identity user-administration tests."""

import pytest
from uuid6 import uuid7

import app.systems.access.users.service as user_service
from app.systems.manage.workspace.models import WorkspaceProfile


@pytest.fixture
def local_identity_security_events(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(user_service, "_security_event", lambda **_kwargs: None)
    organization = WorkspaceProfile(id=uuid7())
    monkeypatch.setattr(user_service, "bound_organization", lambda _db: organization.id)
