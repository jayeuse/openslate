"""Shared router settings for local-identity HTTP contract tests."""

from types import SimpleNamespace

import pytest

import app.systems.access.auth.router as auth_router


@pytest.fixture
def local_auth_router_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        auth_router,
        "get_settings",
        lambda: SimpleNamespace(cors_origins=["https://app.example.test"]),
    )
    monkeypatch.setattr(
        auth_router, "invitation_completion_permitted", lambda *_args, **_kwargs: True
    )
