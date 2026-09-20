"""Shared audit isolation for local-identity user-administration tests."""

import pytest

import app.systems.access.users.service as user_service


@pytest.fixture
def local_identity_security_events(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(user_service, "_security_event", lambda **_kwargs: None)
